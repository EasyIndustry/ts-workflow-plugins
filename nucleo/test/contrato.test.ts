import { crearRegistro } from "ts-workflow-core";
import { describe, expect, it } from "vitest";
import { definirPlugin, efectosDe, ErrorPlugin, type DefinicionPlugin } from "../src/index.js";

const base: DefinicionPlugin = { id: "demo", version: "1.2.3", permisos: ["red"] };
const nada = async () => undefined;
const evento = { id: "demo.paso", nombre: "Pasó", tipo: "evento" as const };
const conEscucha = { sincronizar: async () => ({ creados: [], borrados: [], conservados: [] }), escuchar: async () => nada };

describe("definirPlugin", () => {
  it("arma un proveedor que entra en el registro del core, sin funciones de ejecución", () => {
    const p = definirPlugin({
      ...base,
      ...conEscucha,
      eventos: [evento],
      condiciones: [{ id: "demo.si", nombre: "Si", tipo: "condicion", evaluar: () => true }],
      efectos: [{ id: "demo.hacer", nombre: "Hacer", tipo: "efecto", ejecutar: nada }],
    });
    const registro = crearRegistro([p.proveedor]);
    expect(registro.descriptores("evento").map((d) => d.id)).toEqual(["demo.paso"]);
    expect(registro.obtener("demo.hacer")).not.toHaveProperty("ejecutar");
    expect(Object.keys(efectosDe([p]))).toEqual(["demo.hacer"]);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it.each([
    ["id", { ...base, id: "Con Espacios" }],
    ["versión", { ...base, version: "1.2" }],
    ["permisos", { ...base, permisos: undefined as never }],
    ["permiso desconocido", { ...base, permisos: ["root" as never] }],
    ["espacio de nombres", { ...base, ...conEscucha, eventos: [{ ...evento, id: "otro.paso" }] }],
    ["tipo cruzado", { ...base, ...conEscucha, eventos: [{ ...evento, tipo: "efecto" as never }] }],
    ["repetida", { ...base, ...conEscucha, eventos: [evento, evento] }],
    ["efecto sin ejecutar", { ...base, efectos: [{ id: "demo.x", nombre: "X", tipo: "efecto" as const, ejecutar: undefined as never }] }],
    ["eventos sin escuchar", { ...base, eventos: [evento] }],
  ])("rechaza: %s", (_n, def) => {
    expect(() => definirPlugin(def as DefinicionPlugin)).toThrow(ErrorPlugin);
  });
});
