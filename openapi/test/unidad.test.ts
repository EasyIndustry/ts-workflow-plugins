import { describe, expect, it } from "vitest";
import { crearRegistro } from "ts-workflow-core";
import { ErrorDefinitivo, ErrorPlugin, type EntradaEfecto } from "../../nucleo/src/index.js";
import { crearPluginOpenApi, ErrorEspecificacion, ficha, idDeOperacion, operacionesDe } from "../src/index.js";

/** Una API inventada de pedidos, con lo que suele traer una especificación: referencias, parámetros comunes y un árbol. */
const ESPECIFICACION = {
  openapi: "3.0.3",
  paths: {
    "/pedidos": {
      get: { operationId: "listarPedidos", tags: ["Pedidos"], parameters: [{ name: "estado", in: "query", schema: { type: "string" } }, { $ref: "#/components/parameters/Pagina" }] },
      post: { summary: "Crear un pedido", description: "Da de alta un pedido.", tags: ["Pedidos"], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PedidoNuevo" } } } } },
    },
    "/pedidos/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      patch: { tags: ["Pedidos"], requestBody: { content: { "application/json": { schema: { type: "object", properties: { nota: { type: "string" } } } } } } },
      delete: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "motivo", in: "query", required: true, schema: { type: "string" } }] },
    },
    "/categorias": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Categoria" } } } } } },
    "/archivos": { post: { requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } } } },
  },
  components: {
    parameters: { Pagina: { name: "pagina", in: "query", schema: { type: "integer", minimum: 1 } } },
    schemas: {
      PedidoNuevo: { type: "object", required: ["cliente"], properties: { cliente: { type: "string" }, renglones: { type: "array", items: { $ref: "#/components/schemas/Renglon" } } } },
      Renglon: { type: "object", properties: { codigo: { type: "string" }, cantidad: { type: "integer" } } },
      Categoria: { type: "object", properties: { nombre: { type: "string" }, hijas: { type: "array", items: { $ref: "#/components/schemas/Categoria" } } } },
    },
  },
};

const porId = () => new Map(operacionesDe(ESPECIFICACION).map((o) => [o.id, o]));

describe("leer la especificación", () => {
  it("saca una operación por método, con un id estable aunque no tenga operationId", () => {
    expect(operacionesDe(ESPECIFICACION).map((o) => o.id)).toEqual(["listarPedidos", "post-pedidos", "patch-pedidos-id", "delete-pedidos-id", "post-categorias", "post-archivos"]);
    expect(idDeOperacion("post", "/pedidos/{id}/cerrar")).toBe("post-pedidos-id-cerrar");
    expect(porId().get("post-pedidos")).toMatchObject({ capacidad: "openapi.post-pedidos", metodo: "post", ruta: "/pedidos", nombre: "Crear un pedido", descripcion: "Da de alta un pedido.", grupo: "Pedidos" });
  });

  it("sin summary, el nombre es el operationId o el método y la ruta", () => {
    expect(porId().get("listarPedidos")!.nombre).toBe("listarPedidos");
    expect(porId().get("patch-pedidos-id")!.nombre).toBe("PATCH /pedidos/{id}");
  });

  it("arma el schema de lo que recibe y resuelve las referencias", () => {
    expect(porId().get("post-pedidos")!.schemaEntrada).toEqual({
      type: "object",
      required: ["cuerpo"],
      additionalProperties: false,
      properties: {
        cuerpo: {
          type: "object",
          required: ["cliente"],
          properties: { cliente: { type: "string" }, renglones: { type: "array", items: { type: "object", properties: { codigo: { type: "string" }, cantidad: { type: "integer" } } } } },
        },
      },
    });
    expect(porId().get("listarPedidos")!.schemaEntrada).toEqual({
      type: "object",
      required: [],
      additionalProperties: false,
      properties: { consulta: { type: "object", required: [], additionalProperties: false, properties: { estado: { type: "string" }, pagina: { type: "integer", minimum: 1 } } } },
    });
  });

  it("los parámetros de la ruta son obligatorios y los de la operación pisan a los comunes", () => {
    const borrar = porId().get("delete-pedidos-id")!;
    expect(borrar.schemaEntrada).toMatchObject({
      required: ["ruta", "consulta"],
      properties: { ruta: { required: ["id"], properties: { id: { type: "string" } } }, consulta: { required: ["motivo"] } },
    });
    expect(porId().get("patch-pedidos-id")!.schemaEntrada).toMatchObject({ required: ["ruta"], properties: { ruta: { properties: { id: { type: "integer" } } } } });
  });

  it("una referencia que se nombra a sí misma se corta, y un cuerpo que no es JSON no cuenta", () => {
    expect(porId().get("post-categorias")!.schemaEntrada["properties"]).toEqual({
      cuerpo: { type: "object", properties: { nombre: { type: "string" }, hijas: { type: "array", items: {} } } },
    });
    expect(porId().get("post-archivos")).toMatchObject({ tieneCuerpo: false, schemaEntrada: { properties: {} } });
  });

  it("rechaza lo que no es OpenAPI 3 y los ids repetidos", () => {
    expect(() => operacionesDe({ swagger: "2.0", paths: {} })).toThrow(ErrorEspecificacion);
    expect(() => operacionesDe({ swagger: "2.0", paths: {} })).toThrow("«2.0»");
    expect(() => operacionesDe(null)).toThrow(ErrorEspecificacion);
    expect(() => operacionesDe({ openapi: "3.1.0", paths: { "/a/{b}": { get: {} }, "/a/b": { get: {} } } })).toThrow("«get-a-b»");
  });
});

function entrada(params: Record<string, unknown>): EntradaEfecto {
  return { clave: "clave-1", params, evento: { id: "evento-7", evento: "algo.paso" }, flujo: "pedidos", instancia: "instancia ñ 3", cadena: { raiz: "evento-7", profundidad: 0 } };
}

/** Un `fetch` de mentira que anota lo que le piden y responde lo que le digan. */
function servidor(responder: () => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const pedidos: { url: string; init: RequestInit }[] = [];
  const falso = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    pedidos.push({ url: String(url), init: init ?? {} });
    return responder();
  }) as typeof fetch;
  return { pedidos, falso };
}

const crear = (extra: Partial<Parameters<typeof crearPluginOpenApi>[0]> = {}) =>
  crearPluginOpenApi({ especificacion: ESPECIFICACION, urlBase: "https://api.ejemplo.test/v1/", permitidas: ["post-pedidos", "delete-pedidos-id", "listarPedidos"], ...extra });
const ejecutar = (plugin: ReturnType<typeof crear>, id: string, params: Record<string, unknown>) => plugin.efectos.find((e) => e.id === id)!.ejecutar(entrada(params));

describe("el plugin", () => {
  it("coincide con su ficha y por defecto no expone nada", () => {
    const vacio = crearPluginOpenApi({ especificacion: ESPECIFICACION, urlBase: "https://api.ejemplo.test" });
    expect({ id: vacio.id, version: vacio.version, permisos: vacio.permisos }).toEqual({ id: ficha.id, version: ficha.version, permisos: ["red"] });
    expect(vacio.efectos).toEqual([]);
  });

  it("expone solo lo permitido, con el nombre que le den, y entra en el registro del core", () => {
    const plugin = crear({ permitidas: ["post-pedidos", { id: "delete-pedidos-id", nombre: "Anular un pedido", descripcion: "Lo da de baja." }, "post-pedidos"] });
    expect(plugin.efectos.map((e) => [e.id, e.nombre, e.descripcion])).toEqual([
      ["openapi.post-pedidos", "Crear un pedido", "Da de alta un pedido."],
      ["openapi.delete-pedidos-id", "Anular un pedido", "Lo da de baja."],
    ]);
    expect(crearRegistro([plugin.proveedor]).descriptores().map((d) => d.id)).toEqual(["openapi.post-pedidos", "openapi.delete-pedidos-id"]);
  });

  it("falla al crearse si una operación permitida no existe o la dirección no sirve", () => {
    expect(() => crear({ permitidas: ["no-existe"] })).toThrow(ErrorPlugin);
    expect(() => crear({ urlBase: "no es una dirección" })).toThrow(ErrorPlugin);
    expect(() => crear({ urlBase: "ftp://api.ejemplo.test" })).toThrow("http o https");
  });
});

describe("ejecutar una operación", () => {
  it("arma el pedido: dirección, valores escapados, cuerpo, credencial e identidad del flujo", async () => {
    const { pedidos, falso } = servidor();
    const plugin = crear({ fetch: falso, credencial: async () => "Bearer secreto" });
    await ejecutar(plugin, "openapi.delete-pedidos-id", { ruta: { id: "a/b ?" }, consulta: { motivo: "se arrepintió", otro: "no va" } });
    await ejecutar(plugin, "openapi.post-pedidos", { cuerpo: { cliente: "Ana" } });
    await ejecutar(plugin, "openapi.listarPedidos", { consulta: { estado: ["nuevo", "listo"], pagina: null } });

    expect(pedidos.map((p) => [p.init.method, p.url])).toEqual([
      ["DELETE", "https://api.ejemplo.test/v1/pedidos/a%2Fb%20%3F?motivo=se+arrepinti%C3%B3"],
      ["POST", "https://api.ejemplo.test/v1/pedidos"],
      ["GET", "https://api.ejemplo.test/v1/pedidos?estado=nuevo&estado=listo"],
    ]);
    expect(pedidos[1]!.init.body).toBe('{"cliente":"Ana"}');
    expect(pedidos[1]!.init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer secreto",
      "idempotency-key": "clave-1",
      "x-flujo": "pedidos",
      "x-flujo-instancia": "instancia%20%C3%B1%203",
      "x-flujo-evento": "evento-7",
    });
    expect(pedidos[0]!.init.body).toBeUndefined();
    expect(pedidos[0]!.init.redirect).toBe("manual");
  });

  it("sin credencial no manda Authorization", async () => {
    const { pedidos, falso } = servidor();
    await ejecutar(crear({ fetch: falso }), "openapi.post-pedidos", { cuerpo: {} });
    expect(pedidos[0]!.init.headers).not.toHaveProperty("authorization");
  });

  it("lo que no se arregla reintentando es un error definitivo", async () => {
    for (const estado of [400, 401, 403, 404, 409, 422, 302]) {
      const plugin = crear({ fetch: servidor(() => new Response("datos que no van al mensaje", { status: estado })).falso });
      const error = await ejecutar(plugin, "openapi.post-pedidos", { cuerpo: {} }).catch((e: unknown) => e);
      expect(error, String(estado)).toBeInstanceOf(ErrorDefinitivo);
      expect((error as Error).message).toBe(`POST /pedidos respondió ${estado}.`);
    }
    const { pedidos, falso } = servidor();
    await expect(ejecutar(crear({ fetch: falso }), "openapi.delete-pedidos-id", { consulta: { motivo: "x" } })).rejects.toThrow(ErrorDefinitivo);
    expect(pedidos).toEqual([]);
  });

  it("lo que puede andar de nuevo es un error común, para que el ejecutor reintente", async () => {
    for (const estado of [500, 502, 503, 408, 429]) {
      const error = await ejecutar(crear({ fetch: servidor(() => new Response(null, { status: estado })).falso }), "openapi.post-pedidos", { cuerpo: {} }).catch((e: unknown) => e);
      expect(error, String(estado)).toBeInstanceOf(Error);
      expect(error, String(estado)).not.toBeInstanceOf(ErrorDefinitivo);
    }
    const sinRed = crear({ fetch: servidor(() => Promise.reject(new TypeError("fetch failed"))).falso });
    const error = await ejecutar(sinRed, "openapi.post-pedidos", { cuerpo: {} }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ErrorDefinitivo);
    expect((error as Error).message).toBe("POST /pedidos: no se pudo conectar.");
  });

  it("corta si la API no responde a tiempo", async () => {
    const colgado = ((_: unknown, init?: RequestInit) => new Promise((_, rechazar) => init!.signal!.addEventListener("abort", () => rechazar(new Error("abortado"))))) as typeof fetch;
    const error = await ejecutar(crear({ fetch: colgado, tiempoMs: 20 }), "openapi.post-pedidos", { cuerpo: {} }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("POST /pedidos: no respondió a tiempo.");
    expect(error).not.toBeInstanceOf(ErrorDefinitivo);
  });
});
