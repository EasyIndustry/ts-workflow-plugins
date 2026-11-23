import { crearRegistro, validarDefinicion, type DefinicionFlujo, type Suscripcion } from "ts-workflow-core";
import { describe, expect, it, vi } from "vitest";
import { ErrorPlugin } from "../../nucleo/src/index.js";
import { conCadena, crearAlmacenPostgres, crearPluginPostgresTriggers, EVENTOS, ficha, SQL_INSTALACION, type ClienteSql } from "../src/index.js";
import { deseadasDe, eventosDeFila, leerCadena, partirTabla, validarPermitidas, type FilaOutbox, type FilaSuscripcion } from "../src/suscripciones.js";

const permitidas = { "public.pagos": ["estado", "monto"], "public.envios": ["estado"] };
const sub = (evento: string, params: Record<string, unknown>): Suscripcion => ({ clave: "a".repeat(64), evento, params });
const cliente = (): ClienteSql & { query: ReturnType<typeof vi.fn> } => ({ query: vi.fn(async () => ({ rows: [{ r: { creados: [], borrados: [], conservados: [] } }] })) });

describe("identificadores", () => {
  it.each(["pagos", "a.b.c", 'public."pagos"', "public.pagos; DROP TABLE x", "public.Pagos", "public.pa gos", "public.", ".pagos", "public.pagos--", 7, null])("rechaza %s", (v) => {
    expect(() => partirTabla(v)).toThrow(ErrorPlugin);
  });
  it("acepta esquema.tabla", () => expect(partirTabla("public.pagos")).toEqual({ esquema: "public", tabla: "pagos" }));
  it("valida la lista permitida", () => {
    expect(() => validarPermitidas({})).toThrow("vacía");
    expect(() => validarPermitidas({ "public.pagos": [] })).toThrow("al menos un campo");
    expect(() => validarPermitidas({ "public.pagos": ['x"; --'] })).toThrow("campo inválido");
    expect(() => validarPermitidas({ 'public.pagos"': ["x"] })).toThrow(ErrorPlugin);
  });
});

describe("deseadasDe", () => {
  it("convierte, ordena campos e ignora eventos de otros plugins", () => {
    const r = deseadasDe([sub(EVENTOS.UPDATE, { tabla: "public.pagos", campos: ["monto", "estado", "monto"] }), sub("otro.evento", { lo: "que sea" })], permitidas);
    expect(r).toEqual([expect.objectContaining({ esquema: "public", tabla: "pagos", operacion: "UPDATE", campos: ["estado", "monto"] })]);
  });
  it.each([
    ["tabla fuera de la lista", sub(EVENTOS.INSERT, { tabla: "public.usuarios" })],
    ["nombre heredado de Object", sub(EVENTOS.INSERT, { tabla: "public.constructor" })],
    ["campo fuera de la lista", sub(EVENTOS.UPDATE, { tabla: "public.pagos", campos: ["clave"] })],
    ["inyección en campo", sub(EVENTOS.UPDATE, { tabla: "public.pagos", campos: ['estado"; DROP TABLE x; --'] })],
    ["inyección en tabla", sub(EVENTOS.INSERT, { tabla: "public.pagos; DROP TABLE x" })],
    ["campos vacío", sub(EVENTOS.UPDATE, { tabla: "public.pagos", campos: [] })],
    ["campos en un insert", sub(EVENTOS.INSERT, { tabla: "public.pagos", campos: ["estado"] })],
    ["parámetro de más", sub(EVENTOS.INSERT, { tabla: "public.pagos", sql: "SELECT 1" })],
  ])("rechaza: %s", (_n, s) => {
    expect(() => deseadasDe([s], permitidas)).toThrow(ErrorPlugin);
  });
});

describe("eventosDeFila", () => {
  const fila: FilaOutbox = { id: "12", esquema: "public", tabla: "pagos", operacion: "UPDATE", pk: { id: 1 }, antes: { estado: "a" }, despues: { estado: "b" }, cambiados: ["estado"], cadena: "raiz:1|2", intentos: 1 };
  const s = (campos: string[] | null, clave = "b".repeat(64)): FilaSuscripcion => ({ clave, evento: EVENTOS.UPDATE, esquema: "public", tabla: "pagos", operacion: "UPDATE", campos, params: { tabla: "public.pagos" } });

  it("filtra por tabla, operación y campos cambiados", () => {
    expect(eventosDeFila(fila, [s(["monto"])])).toEqual([]);
    expect(eventosDeFila(fila, [{ ...s(null), tabla: "envios" }])).toEqual([]);
    expect(eventosDeFila(fila, [{ ...s(null), operacion: "DELETE" }])).toEqual([]);
    expect(eventosDeFila(fila, [s(["estado"]), s(null, "c".repeat(64))])).toHaveLength(2);
  });
  it("el id es estable y hereda la cadena", () => {
    const [e] = eventosDeFila(fila, [s(null)]);
    expect(e!.id).toBe(`outbox:12:${"b".repeat(16)}`);
    expect(e!.cadena).toEqual({ raiz: "raiz:1", profundidad: 2 });
  });
  it("una cadena inválida se ignora", () => {
    expect(leerCadena("x|y")).toBeUndefined();
    expect(leerCadena(null)).toBeUndefined();
  });
});

describe("plugin", () => {
  it("cumple el contrato y sus eventos entran al registro", () => {
    const p = crearPluginPostgresTriggers({ cliente: cliente(), permitidas });
    expect([p.id, p.version]).toEqual([ficha.id, ficha.version]);
    expect(crearRegistro([p.proveedor]).descriptores("evento")).toHaveLength(3);
  });

  it("validarDefinicion rechaza una tabla que no está en la lista permitida", () => {
    const registro = crearRegistro([crearPluginPostgresTriggers({ cliente: cliente(), permitidas }).proveedor, { nombre: "app", capacidades: [{ id: "ir", nombre: "Ir", tipo: "accion" }] }]);
    const d = (tabla: string): DefinicionFlujo => ({
      id: "f",
      version: 1,
      nombre: "F",
      estadoInicial: "a",
      estados: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B", final: true }],
      transiciones: [{ id: "t", accion: "ir", desde: ["a"], hacia: "b" }],
      reacciones: [{ id: "r", evento: EVENTOS.INSERT, params: { tabla }, desde: ["a"], transicion: "t" }],
    });
    expect(validarDefinicion(d("public.pagos"), registro).valido).toBe(true);
    expect(validarDefinicion(d("public.usuarios"), registro).errores[0]?.codigo).toBe("params_invalidos");
  });

  it("sincronizar pasa todo como parámetro, nunca dentro del texto SQL", async () => {
    const c = cliente();
    await crearPluginPostgresTriggers({ cliente: c, permitidas }).sincronizar!([sub(EVENTOS.INSERT, { tabla: "public.pagos" })]);
    const [texto, valores] = c.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(texto).not.toContain("pagos");
    expect(String(valores[0])).toContain("pagos");
    expect(valores[1]).toBe(false);
  });

  it("una suscripción no permitida no llega a la base", async () => {
    const c = cliente();
    await expect(crearPluginPostgresTriggers({ cliente: c, permitidas }).sincronizar!([sub(EVENTOS.INSERT, { tabla: "public.usuarios" })])).rejects.toThrow(ErrorPlugin);
    expect(c.query).not.toHaveBeenCalled();
  });
});

describe("conCadena", () => {
  it("confirma si sale bien y revierte si falla", async () => {
    const c = cliente();
    await conCadena(c, { raiz: "r", profundidad: 1 }, async () => 1);
    expect(c.query.mock.calls.map((x) => x[0])).toEqual(["BEGIN", "SELECT set_config('flujo.cadena', $1, true)", "COMMIT"]);
    const d = cliente();
    await expect(conCadena(d, { raiz: "r", profundidad: 1 }, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(d.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });
});

describe("SQL fijo", () => {
  it("las funciones con privilegios fijan search_path", () => {
    const definer = SQL_INSTALACION.match(/CREATE OR REPLACE FUNCTION[^$]*?SECURITY DEFINER[^$]*?AS \$fn\$/g) ?? [];
    expect(definer.length).toBe(5 + 1);
    for (const d of definer) expect(d).toContain("SET search_path = pg_catalog, pg_temp");
  });
  it("la reconciliación tiene lock_timeout y nadie más que el administrador puede permitir tablas", () => {
    expect(SQL_INSTALACION).toContain("SET lock_timeout = '3s'");
    expect(SQL_INSTALACION).toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA flujo FROM PUBLIC");
    expect(SQL_INSTALACION).not.toMatch(/GRANT[^;]*flujo\.permitir/);
  });
  it("el almacén usa parámetros", async () => {
    const c = cliente();
    await crearAlmacenPostgres(c).marcarPaso("x'; DROP TABLE y; --");
    expect(c.query.mock.calls[0]![0]).not.toContain("DROP");
  });
});
