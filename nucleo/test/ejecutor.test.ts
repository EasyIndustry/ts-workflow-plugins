import { crearRegistro, type DefinicionFlujo } from "ts-workflow-core";
import { describe, expect, it, vi } from "vitest";
import { crearAlmacenMemoria, crearEjecutor, ErrorDefinitivo, suscripcionesNecesarias, type EventoEntrante, type OpcionesEjecutor } from "../src/index.js";

type Ctx = { pago: boolean };
const registro = crearRegistro<Ctx>([
  {
    nombre: "prueba",
    capacidades: [
      { id: "ir", nombre: "Ir", tipo: "accion" },
      { id: "pagado", nombre: "Pagado", tipo: "condicion", texto: { cumple: "Pagado", noCumple: "Falta el pago" }, evaluar: (_p, c) => c.pago },
      { id: "avisar", nombre: "Avisar", tipo: "efecto" },
      { id: "anotar", nombre: "Anotar", tipo: "efecto" },
      { id: "dato.cambio", nombre: "Cambio", tipo: "evento" },
    ],
  },
]);
const flujo: DefinicionFlujo = {
  id: "f",
  version: 1,
  nombre: "F",
  estadoInicial: "a",
  estados: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B", final: true }],
  transiciones: [{ id: "t", accion: "ir", desde: ["a"], hacia: "b", requisitos: { condicion: "pagado" }, efectos: [{ efecto: "avisar" }, { efecto: "anotar" }] }],
  reacciones: [{ id: "r", evento: "dato.cambio", desde: ["a"], transicion: "t" }],
};
const ev = (id = "e1", extra: Partial<EventoEntrante> = {}): EventoEntrante => ({ id, evento: "dato.cambio", ...extra });

function armar(cambios: Partial<OpcionesEjecutor<Ctx>> = {}, pago = true) {
  const almacen = crearAlmacenMemoria();
  const avisar = vi.fn(async () => undefined);
  const anotar = vi.fn(async () => undefined);
  const aplicarTransicion = vi.fn(async () => undefined);
  const dormir = vi.fn(async () => undefined);
  const ejecutor = crearEjecutor<Ctx>({
    registro,
    almacen,
    objetivos: async () => [{ flujo, id: "i1", instancia: { version: 1, estado: "a" }, contexto: { pago } }],
    aplicarTransicion,
    efectos: { avisar, anotar },
    dormir,
    ...cambios,
  });
  return { ejecutor, almacen, avisar, anotar, aplicarTransicion, dormir };
}

describe("ejecutor", () => {
  it("aplica la transición y después los efectos, en orden", async () => {
    const orden: string[] = [];
    const { ejecutor } = armar({
      aplicarTransicion: async () => void orden.push("transicion"),
      efectos: { avisar: async () => void orden.push("avisar"), anotar: async () => void orden.push("anotar") },
    });
    const [r] = await ejecutor.procesar(ev());
    expect(r).toMatchObject({ instancia: "i1", estado: "aplicado" });
    expect(orden).toEqual(["transicion", "avisar", "anotar"]);
  });

  it("idempotencia: el mismo evento entregado dos veces se ejecuta una", async () => {
    const { ejecutor, avisar, aplicarTransicion } = armar();
    await ejecutor.procesar(ev());
    expect((await ejecutor.procesar(ev()))[0]!.estado).toBe("repetido");
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(aplicarTransicion).toHaveBeenCalledTimes(1);
  });

  it("otro evento sí se ejecuta", async () => {
    const { ejecutor, avisar } = armar();
    await ejecutor.procesar(ev("e1"));
    await ejecutor.procesar(ev("e2"));
    expect(avisar).toHaveBeenCalledTimes(2);
  });

  it("sin reacción o con requisitos sin cumplir no ejecuta nada", async () => {
    const otro = armar({ objetivos: async () => [{ flujo, id: "i1", instancia: { version: 1, estado: "b" }, contexto: { pago: true } }] });
    expect((await otro.ejecutor.procesar(ev()))[0]!.estado).toBe("sin_reaccion");
    const bloqueado = armar({}, false);
    expect((await bloqueado.ejecutor.procesar(ev()))[0]).toMatchObject({ estado: "no_aplica", motivos: ["Falta el pago"] });
    expect(bloqueado.aplicarTransicion).not.toHaveBeenCalled();
  });

  it("reintenta con espera creciente y la misma clave", async () => {
    const claves: string[] = [];
    let veces = 0;
    const { ejecutor, dormir } = armar({
      efectos: {
        avisar: async ({ clave }) => {
          claves.push(clave);
          if (++veces < 3) throw new Error("se cayó");
        },
        anotar: async () => undefined,
      },
    });
    expect((await ejecutor.procesar(ev()))[0]!.estado).toBe("aplicado");
    expect(new Set(claves).size).toBe(1);
    expect(dormir.mock.calls.map((c) => (c as unknown[])[0])).toEqual([200, 400]);
  });

  it("agotados los reintentos va a fallidos, corta los pasos siguientes y se puede retomar sin repetir lo hecho", async () => {
    let roto = true;
    const anotar = vi.fn(async () => undefined);
    const avisar = vi.fn(async () => {
      if (roto) throw new Error("sin red");
    });
    const { ejecutor, almacen, aplicarTransicion } = armar({ efectos: { avisar, anotar } });
    expect((await ejecutor.procesar(ev()))[0]!.estado).toBe("fallido");
    expect(avisar).toHaveBeenCalledTimes(3);
    expect(anotar).not.toHaveBeenCalled();
    const [f] = await almacen.fallidos();
    expect(f).toMatchObject({ motivo: "reintentos_agotados", paso: "efecto:0:avisar", error: "sin red", intentos: 3 });

    roto = false;
    expect((await ejecutor.reintentarFallido(f!.clave)).estado).toBe("aplicado");
    expect(aplicarTransicion).toHaveBeenCalledTimes(1);
    expect(anotar).toHaveBeenCalledTimes(1);
    expect(await almacen.fallidos()).toEqual([]);
    expect((await ejecutor.procesar(ev()))[0]!.estado).toBe("repetido");
  });

  it("una redelivery usa el plan guardado aunque la instancia ya haya cambiado de estado", async () => {
    let falla = true;
    let estado = "a";
    const anotar = vi.fn(async () => undefined);
    const aplicarTransicion = vi.fn(async () => void (estado = "b"));
    const { ejecutor, almacen } = armar({
      objetivos: async () => [{ flujo, id: "i1", instancia: { version: 1, estado }, contexto: { pago: true } }],
      aplicarTransicion,
      efectos: {
        avisar: async () => {
          if (falla) throw new Error("x");
        },
        anotar,
      },
      maxIntentos: 1,
    });
    await ejecutor.procesar(ev());
    expect(estado).toBe("b");
    expect(await almacen.fallidos()).toHaveLength(1);
    falla = false;
    // El estado ya es «b», donde nadie escucha: sin el plan guardado se perderían los efectos pendientes.
    expect((await ejecutor.procesar(ev()))[0]!.estado).toBe("aplicado");
    expect(aplicarTransicion).toHaveBeenCalledTimes(1);
    expect(anotar).toHaveBeenCalledTimes(1);
    expect(await almacen.fallidos()).toEqual([]);
  });

  it("un plan guardado que no aplicaba se respeta al volver a entregar", async () => {
    let pago = false;
    const almacen = crearAlmacenMemoria();
    const aplicarTransicion = vi.fn(async () => undefined);
    const ejecutor = crearEjecutor<Ctx>({
      registro,
      almacen,
      objetivos: async () => [{ flujo, id: "i1", instancia: { version: 1, estado: "a" }, contexto: { pago } }],
      aplicarTransicion,
      efectos: {},
    });
    await ejecutor.procesar(ev());
    pago = true;
    expect((await ejecutor.procesar(ev()))[0]!.estado).toBe("repetido");
    expect(aplicarTransicion).not.toHaveBeenCalled();
  });

  it("un error definitivo no se reintenta", async () => {
    const avisar = vi.fn(async () => {
      throw new ErrorDefinitivo("dato inválido");
    });
    const { ejecutor, almacen } = armar({ efectos: { avisar, anotar: async () => undefined } });
    await ejecutor.procesar(ev());
    expect(avisar).toHaveBeenCalledTimes(1);
    expect((await almacen.fallidos())[0]).toMatchObject({ motivo: "error_definitivo" });
  });

  it("un efecto sin implementación va a fallidos, incluso con un nombre heredado de Object", async () => {
    const f2: DefinicionFlujo = { ...flujo, transiciones: [{ ...flujo.transiciones[0]!, efectos: [{ efecto: "avisar" }] }] };
    const { ejecutor, almacen } = armar({ objetivos: async () => [{ flujo: f2, id: "i1", instancia: { version: 1, estado: "a" }, contexto: { pago: true } }], efectos: {} });
    await ejecutor.procesar(ev());
    expect((await almacen.fallidos())[0]).toMatchObject({ motivo: "error_definitivo", paso: "efecto:0:avisar" });
  });

  it("tope de cadena: corta el bucle sin ejecutar y deja el caso en fallidos", async () => {
    const { ejecutor, almacen, aplicarTransicion } = armar({ topeCadena: 2 });
    expect((await ejecutor.procesar(ev("e9", { cadena: { raiz: "e1", profundidad: 2 } })))[0]!.estado).toBe("fallido");
    expect(aplicarTransicion).not.toHaveBeenCalled();
    expect((await almacen.fallidos())[0]).toMatchObject({ motivo: "tope_de_cadena", paso: "cadena" });
    await expect(ejecutor.reintentarFallido((await almacen.fallidos())[0]!.clave)).rejects.toThrow(ErrorDefinitivo);
  });

  it("propaga la cadena con un salto más a transición y efectos", async () => {
    const cadenas: unknown[] = [];
    const { ejecutor } = armar({
      aplicarTransicion: async ({ cadena }) => void cadenas.push(cadena),
      efectos: { avisar: async ({ cadena }) => void cadenas.push(cadena), anotar: async () => undefined },
    });
    await ejecutor.procesar(ev("e5", { cadena: { raiz: "e1", profundidad: 3 } }));
    expect(cadenas).toEqual([{ raiz: "e1", profundidad: 4 }, { raiz: "e1", profundidad: 4 }]);
    cadenas.length = 0;
    await ejecutor.procesar(ev("e6"));
    expect(cadenas[0]).toEqual({ raiz: "e6", profundidad: 1 });
  });

  it("una versión inexistente va a fallidos como plan inválido y no frena a las otras instancias", async () => {
    const { ejecutor, almacen, avisar } = armar({
      objetivos: async () => [
        { flujo, id: "rota", instancia: { version: 9, estado: "a" }, contexto: { pago: true } },
        { flujo, id: "sana", instancia: { version: 1, estado: "a" }, contexto: { pago: true } },
      ],
    });
    const r = await ejecutor.procesar(ev());
    expect(r.map((x) => x.estado)).toEqual(["fallido", "aplicado"]);
    expect(avisar).toHaveBeenCalledTimes(1);
    expect((await almacen.fallidos())[0]).toMatchObject({ motivo: "plan_invalido", instancia: "rota", flujo: "f" });
  });

  it("si cargar los objetivos falla, procesar falla (para que el evento se vuelva a entregar)", async () => {
    const { ejecutor } = armar({ objetivos: async () => Promise.reject(new Error("sin base")) });
    await expect(ejecutor.procesar(ev())).rejects.toThrow("sin base");
  });

  it("reintentar una clave que no existe falla", async () => {
    await expect(armar().ejecutor.reintentarFallido("nada")).rejects.toThrow("No hay un fallido");
  });
});

describe("suscripcionesNecesarias", () => {
  const conEvento = (version: number, evento: string): DefinicionFlujo => ({ ...flujo, version, reacciones: [{ id: "r", evento, desde: ["a"], transicion: "t" }] });

  it("conserva la última y las viejas con instancias activas; suelta las demás", () => {
    const versiones = [conEvento(1, "uno"), conEvento(2, "dos"), conEvento(3, "tres")];
    expect(suscripcionesNecesarias(versiones, { f: [1] }).map((s) => s.evento).sort()).toEqual(["tres", "uno"]);
    expect(suscripcionesNecesarias(versiones, {}).map((s) => s.evento)).toEqual(["tres"]);
  });
});
