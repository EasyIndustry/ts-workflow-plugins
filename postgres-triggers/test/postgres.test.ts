import { randomBytes } from "node:crypto";
import pg from "pg";
import { crearRegistro, huella, suscripciones, type DefinicionFlujo, type Suscripcion } from "ts-workflow-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEjecutor, suscripcionesNecesarias, type EventoEntrante } from "../../nucleo/src/index.js";
import { autorizar, conCadena, crearAlmacenPostgres, crearPluginPostgresTriggers, EVENTOS, instalar } from "../src/index.js";

const URL_BASE = process.env.PRUEBAS_POSTGRES_URL;
const PERMITIDAS = { "public.pagos": ["estado", "monto"], "public.envios": ["estado"] };
const clave = (evento: string, params: Record<string, unknown>) => huella({ evento, params });
const sub = (evento: string, params: Record<string, unknown>): Suscripcion => ({ clave: clave(evento, params), evento, params });
const alActualizar = (campos?: string[]) => sub(EVENTOS.UPDATE, { tabla: "public.pagos", ...(campos ? { campos } : {}) });
const alInsertar = sub(EVENTOS.INSERT, { tabla: "public.pagos" });
const alBorrar = sub(EVENTOS.DELETE, { tabla: "public.pagos" });

async function hasta(condicion: () => Promise<boolean> | boolean, ms = 4000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await condicion()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no se cumplió a tiempo");
}

describe.skipIf(!URL_BASE)("contra Postgres", () => {
  const db = `prueba_${randomBytes(4).toString("hex")}`;
  const urlDe = (usuario: string | null, clave: string | null, base: string) => {
    const u = new URL(URL_BASE!);
    if (usuario) u.username = usuario;
    if (clave) u.password = clave;
    u.pathname = `/${base}`;
    return u.toString();
  };
  let raiz: pg.Client;
  let admin: pg.Client;
  let api: pg.Pool;
  let apiUna: pg.Client;
  const plugin = (extra: Partial<Parameters<typeof crearPluginPostgresTriggers>[0]> = {}) => crearPluginPostgresTriggers({ cliente: api, permitidas: PERMITIDAS, ...extra });
  const triggers = async () =>
    (await admin.query("SELECT t.tgname::text AS n FROM pg_trigger t WHERE t.tgfoid = 'flujo.registrar()'::regprocedure AND NOT t.tgisinternal ORDER BY 1")).rows.map((r) => r.n as string);
  const outbox = async () => (await admin.query("SELECT * FROM flujo.outbox ORDER BY id")).rows;

  beforeAll(async () => {
    raiz = new pg.Client({ connectionString: URL_BASE });
    await raiz.connect();
    await raiz.query(`CREATE DATABASE ${db}`);
    for (const rol of ["prueba_api", "prueba_dueno"]) {
      await raiz.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN CREATE ROLE ${rol} LOGIN PASSWORD 'solo-ci'; END IF; END $$`);
    }
    admin = new pg.Client({ connectionString: urlDe(null, null, db) });
    await admin.connect();
    await admin.query(`
      GRANT CREATE ON SCHEMA public TO prueba_dueno;
      SET ROLE prueba_dueno;
      CREATE TABLE public.pagos (id serial PRIMARY KEY, estado text, monto int, secreto text);
      CREATE TABLE public.envios (id serial PRIMARY KEY, estado text);
      CREATE TABLE public.sin_permiso (id serial PRIMARY KEY, x text);
      CREATE TABLE public.sin_pk (x text);
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prueba_api;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO prueba_api;
      RESET ROLE;
    `);
    await instalar(admin);
    await autorizar(admin, PERMITIDAS, "prueba_api");
    api = new pg.Pool({ connectionString: urlDe("prueba_api", "solo-ci", db), max: 4 });
    apiUna = new pg.Client({ connectionString: urlDe("prueba_api", "solo-ci", db) });
    await apiUna.connect();
  }, 30000);

  afterAll(async () => {
    await apiUna?.end();
    await api?.end();
    await admin?.end();
    await raiz?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await raiz?.end();
  });

  beforeEach(async () => {
    await admin.query("SELECT flujo.reconciliar('[]'::jsonb, true)");
    await admin.query("TRUNCATE flujo.outbox, flujo.planes, flujo.pasos, flujo.fallidos; TRUNCATE public.pagos, public.envios RESTART IDENTITY");
  });

  describe("instalación y permisos", () => {
    it("instalar es idempotente", async () => {
      await instalar(admin);
      await autorizar(admin, PERMITIDAS, "prueba_api");
    });

    it.each([
      ["crear un trigger", `CREATE TRIGGER x AFTER INSERT ON public.pagos FOR EACH ROW EXECUTE FUNCTION flujo.registrar('id', 'estado')`],
      ["crear una tabla en flujo", "CREATE TABLE flujo.x (id int)"],
      ["leer el outbox", "SELECT * FROM flujo.outbox"],
      ["escribir el outbox", "INSERT INTO flujo.outbox (esquema, tabla, operacion, pk) VALUES ('a', 'b', 'INSERT', '{}')"],
      ["ampliar la lista permitida", "INSERT INTO flujo.permitidos VALUES ('public', 'sin_permiso', '{x}')"],
      ["llamar a permitir", "SELECT flujo.permitir('public.sin_permiso'::regclass, '{x}')"],
      ["concederse permisos", "SELECT flujo.conceder_api('prueba_api'::regrole)"],
      ["borrar la tabla", "DROP TABLE public.pagos"],
    ])("la API no puede %s", async (_n, sql) => {
      await expect(api.query(sql)).rejects.toThrow(/permission denied|must be owner/);
    });

    it("no admite una tabla de un superusuario ni un rol de API superusuario", async () => {
      await admin.query("CREATE TABLE IF NOT EXISTS public.de_super (id int PRIMARY KEY, x text)");
      await expect(admin.query("SELECT flujo.permitir('public.de_super'::regclass, '{x}')")).rejects.toThrow("superusuario");
      await expect(admin.query("SELECT flujo.conceder_api(current_user::text::regrole)")).rejects.toThrow("superusuario");
    });

    it("permitir rechaza campos que no existen", async () => {
      await expect(admin.query("SELECT flujo.permitir('public.pagos'::regclass, '{no_existe}')")).rejects.toThrow("campos inválidos");
    });
  });

  describe("reconciliación", () => {
    it("crea, es idempotente y borra lo que sobra", async () => {
      const p = plugin();
      const r1 = await p.sincronizar!([alInsertar, alActualizar(["estado"])]);
      expect(r1.creados).toHaveLength(2);
      expect(await triggers()).toHaveLength(2);
      const r2 = await p.sincronizar!([alInsertar, alActualizar(["estado"])]);
      expect(r2).toMatchObject({ creados: [], borrados: [] });
      expect(r2.conservados).toHaveLength(2);
      const r3 = await p.sincronizar!([alInsertar]);
      expect(r3.borrados).toHaveLength(1);
      expect(await triggers()).toEqual(r3.conservados);
    });

    it("una lista vacía no borra nada salvo que se pida", async () => {
      await plugin().sincronizar!([alInsertar]);
      await expect(plugin().sincronizar!([])).rejects.toThrow("vacía");
      expect(await triggers()).toHaveLength(1);
      await plugin({ permitirVaciar: true }).sincronizar!([]);
      expect(await triggers()).toEqual([]);
    });

    it("no toca un trigger ajeno aunque se llame flujo_*", async () => {
      await admin.query(`
        CREATE OR REPLACE FUNCTION public.ajena() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        DROP TRIGGER IF EXISTS flujo_ajeno ON public.pagos;
        CREATE TRIGGER flujo_ajeno BEFORE INSERT ON public.pagos FOR EACH ROW EXECUTE FUNCTION public.ajena();
      `);
      await plugin({ permitirVaciar: true }).sincronizar!([]);
      const { rows } = await admin.query("SELECT 1 FROM pg_trigger WHERE tgname = 'flujo_ajeno'");
      expect(rows).toHaveLength(1);
      await admin.query("DROP TRIGGER flujo_ajeno ON public.pagos");
    });

    it("conserva lo que necesitan las versiones con instancias activas", async () => {
      const def = (version: number, s: Suscripcion): DefinicionFlujo => ({
        id: "f",
        version,
        nombre: "F",
        estadoInicial: "a",
        estados: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B", final: true }],
        transiciones: [{ id: "t", accion: "ir", desde: ["a"], hacia: "b" }],
        reacciones: [{ id: "r", evento: s.evento, params: s.params, desde: ["a"], transicion: "t" }],
      });
      const versiones = [def(1, alInsertar), def(2, alBorrar)];
      const p = plugin();
      await p.sincronizar!(suscripcionesNecesarias(versiones, { f: [1] }));
      expect(await triggers()).toHaveLength(2);
      const r = await p.sincronizar!(suscripcionesNecesarias(versiones, {}));
      expect(r.borrados).toHaveLength(1);
      expect(await triggers()).toHaveLength(1);
      expect(suscripciones(versiones)).toHaveLength(2);
    });

    it("dos suscripciones de la misma tabla y operación usan un solo trigger, sin duplicar el outbox", async () => {
      await plugin().sincronizar!([alActualizar(["estado"]), alActualizar(["monto"])]);
      expect(await triggers()).toHaveLength(1);
      await admin.query("INSERT INTO public.pagos (estado, monto) VALUES ('a', 1)");
      await admin.query("UPDATE public.pagos SET estado = 'b', monto = 2");
      expect(await outbox()).toHaveLength(1);
    });

    const crudo = (x: Record<string, unknown>) => JSON.stringify([{ clave: "a".repeat(64), evento: EVENTOS.INSERT, esquema: "public", tabla: "pagos", operacion: "INSERT", campos: null, params: {}, ...x }]);

    it.each([
      ["tabla fuera de la lista", { tabla: "sin_permiso" }],
      ["esquema del sistema", { esquema: "pg_catalog", tabla: "pg_class" }],
      ["inyección en la tabla", { tabla: 'pagos" ON x; DROP TABLE public.pagos; --' }],
      ["inyección en el esquema", { esquema: 'public"; DROP TABLE public.pagos; --' }],
      ["inyección en un campo", { operacion: "UPDATE", campos: ['estado"; DROP TABLE public.pagos; --'] }],
      ["campo no permitido", { operacion: "UPDATE", campos: ["secreto"] }],
      ["operación inventada", { operacion: "TRUNCATE" }],
      ["clave inválida", { clave: "x" }],
      ["campos que no son lista", { campos: "estado" }],
      ["campos vacío", { operacion: "UPDATE", campos: [] }],
    ])("la base rechaza por su cuenta: %s", async (_n, x) => {
      await expect(api.query("SELECT flujo.reconciliar($1::jsonb)", [crudo(x)])).rejects.toThrow(/flujo:/);
      expect(await triggers()).toEqual([]);
      await expect(admin.query("SELECT count(*) FROM public.pagos")).resolves.toBeTruthy();
    });

    it("la base rechaza una entrada que no es una lista", async () => {
      await expect(api.query("SELECT flujo.reconciliar('{}'::jsonb)")).rejects.toThrow("lista");
    });

    it("una tabla sin clave primaria no se puede escuchar", async () => {
      await admin.query("INSERT INTO flujo.permitidos VALUES ('public', 'sin_pk', '{x}') ON CONFLICT DO NOTHING");
      await expect(api.query("SELECT flujo.reconciliar($1::jsonb)", [crudo({ tabla: "sin_pk" })])).rejects.toThrow("clave primaria");
      await admin.query("DELETE FROM flujo.permitidos WHERE tabla = 'sin_pk'");
    });

    it("todo o nada: si una falla no queda ninguna", async () => {
      const buena = JSON.parse(crudo({}))[0];
      const mala = JSON.parse(crudo({ tabla: "sin_permiso", clave: "b".repeat(64) }))[0];
      await expect(api.query("SELECT flujo.reconciliar($1::jsonb)", [JSON.stringify([buena, mala])])).rejects.toThrow();
      expect(await triggers()).toEqual([]);
    });

    it("lock_timeout: con la tabla bloqueada falla rápido y no deja nada a medias", async () => {
      const bloqueo = new pg.Client({ connectionString: urlDe(null, null, db) });
      await bloqueo.connect();
      await bloqueo.query("BEGIN; LOCK TABLE public.pagos IN ACCESS EXCLUSIVE MODE");
      const inicio = Date.now();
      await expect(plugin().sincronizar!([alInsertar])).rejects.toThrow(/lock timeout/);
      expect(Date.now() - inicio).toBeLessThan(6000);
      await bloqueo.query("ROLLBACK");
      await bloqueo.end();
      expect(await triggers()).toEqual([]);
      expect((await plugin().sincronizar!([alInsertar])).creados).toHaveLength(1);
    }, 15000);
  });

  describe("outbox", () => {
    it("guarda solo la clave y los campos permitidos", async () => {
      await plugin().sincronizar!([alInsertar]);
      await api.query("INSERT INTO public.pagos (estado, monto, secreto) VALUES ('nuevo', 5, 'no-debe-salir')");
      const [f] = await outbox();
      expect(f).toMatchObject({ operacion: "INSERT", pk: { id: 1 }, despues: { estado: "nuevo", monto: 5 }, antes: null });
      expect(JSON.stringify(f)).not.toContain("no-debe-salir");
    });

    it("un update sin cambios reales en los campos escuchados no genera evento", async () => {
      await plugin().sincronizar!([alActualizar(["estado"])]);
      await api.query("INSERT INTO public.pagos (estado, monto) VALUES ('a', 1)");
      await api.query("UPDATE public.pagos SET estado = 'a'");
      await api.query("UPDATE public.pagos SET monto = 2");
      expect(await outbox()).toHaveLength(0);
      await api.query("UPDATE public.pagos SET estado = 'b'");
      expect(await outbox()).toMatchObject([{ operacion: "UPDATE", cambiados: ["estado"], antes: { estado: "a" }, despues: { estado: "b" } }]);
    });

    it("registra borrados", async () => {
      await plugin().sincronizar!([alBorrar]);
      await api.query("INSERT INTO public.pagos (estado) VALUES ('a')");
      await api.query("DELETE FROM public.pagos");
      expect(await outbox()).toMatchObject([{ operacion: "DELETE", pk: { id: 1 }, antes: { estado: "a" }, despues: null }]);
    });

    it("si la transacción se revierte, no hay evento", async () => {
      await plugin().sincronizar!([alInsertar]);
      await apiUna.query("BEGIN");
      await apiUna.query("INSERT INTO public.pagos (estado) VALUES ('a')");
      await apiUna.query("ROLLBACK");
      expect(await outbox()).toEqual([]);
    });

    it("una cadena malformada no rompe la escritura y se ignora", async () => {
      await plugin().sincronizar!([alInsertar]);
      await conCadena(apiUna, { raiz: "mala cadena;", profundidad: 1 }, () => apiUna.query("INSERT INTO public.pagos (estado) VALUES ('a')"));
      expect((await outbox())[0].cadena).toBeNull();
    });
  });

  describe("escuchar", () => {
    it("NOTIFY despierta sin esperar el sondeo y confirma", async () => {
      const escucha = new pg.Client({ connectionString: urlDe("prueba_api", "solo-ci", db) });
      await escucha.connect();
      const p = plugin({ conexionEscucha: escucha, sondeoMs: 60000 });
      await p.sincronizar!([alInsertar]);
      const recibidos: EventoEntrante[] = [];
      const detener = await p.escuchar!(async (e) => void recibidos.push(e));
      await new Promise((r) => setTimeout(r, 100));
      await api.query("INSERT INTO public.pagos (estado) VALUES ('a')");
      await hasta(() => recibidos.length === 1);
      await detener();
      await escucha.end();
      expect(recibidos[0]).toMatchObject({ evento: EVENTOS.INSERT, params: { tabla: "public.pagos" }, datos: { pk: { id: 1 } } });
      expect((await outbox())[0].procesado_en).not.toBeNull();
    });

    it("sin NOTIFY, el sondeo levanta lo pendiente", async () => {
      const p = plugin({ sondeoMs: 50 });
      await p.sincronizar!([alInsertar]);
      await api.query("INSERT INTO public.pagos (estado) VALUES ('a')");
      const cb = vi.fn(async () => undefined);
      const detener = await p.escuchar!(cb);
      await hasta(() => cb.mock.calls.length === 1);
      await detener();
    });

    it("si el callback falla, reentrega con el mismo id y al agotar marca fallido", async () => {
      const ids: string[] = [];
      const errores: unknown[] = [];
      const p = plugin({ sondeoMs: 30, maxEntregas: 2, alError: (e) => errores.push(e) });
      await p.sincronizar!([alInsertar]);
      await api.query("INSERT INTO public.pagos (estado) VALUES ('a')");
      await admin.query("UPDATE flujo.outbox SET tomado_hasta = NULL");
      const detener = await p.escuchar!(async (e) => {
        ids.push(e.id);
        await admin.query("UPDATE flujo.outbox SET tomado_hasta = NULL WHERE fallido_en IS NULL");
        throw new Error("falló el callback");
      });
      await hasta(async () => (await outbox())[0].fallido_en !== null, 6000);
      await detener();
      expect(new Set(ids).size).toBe(1);
      expect(ids.length).toBe(2);
      expect((await outbox())[0].error).toBe("falló el callback");
      expect(errores).toHaveLength(2);
    }, 10000);

    it("dos consumidores no toman la misma fila", async () => {
      await plugin().sincronizar!([alInsertar]);
      await api.query("INSERT INTO public.pagos (estado) SELECT 'x' FROM generate_series(1, 40)");
      const vistos: string[] = [];
      const cb = async (e: EventoEntrante) => void vistos.push(e.id);
      const d1 = await plugin({ sondeoMs: 20, lote: 3 }).escuchar!(cb);
      const d2 = await plugin({ sondeoMs: 20, lote: 3 }).escuchar!(cb);
      await hasta(() => vistos.length >= 40, 6000);
      await d1();
      await d2();
      expect(new Set(vistos).size).toBe(vistos.length);
    }, 10000);
  });

  describe("de punta a punta con el ejecutor", () => {
    type Ctx = { aprobado: boolean };
    const flujo: DefinicionFlujo = {
      id: "cobro",
      version: 1,
      nombre: "Cobro",
      estadoInicial: "esperando",
      estados: [{ id: "esperando", nombre: "Esperando" }, { id: "cobrado", nombre: "Cobrado", final: true }],
      transiciones: [{ id: "confirmar", accion: "cobro.confirmar", desde: ["esperando"], hacia: "cobrado", requisitos: { condicion: "cobro.aprobado" }, efectos: [{ efecto: "cobro.avisar" }] }],
      reacciones: [{ id: "al-cambiar", evento: EVENTOS.UPDATE, params: { tabla: "public.pagos", campos: ["estado"] }, desde: ["esperando"], transicion: "confirmar" }],
    };

    it("un cambio en la fila mueve la instancia y ejecuta el efecto una sola vez, aunque se reentregue", async () => {
      const p = plugin({ sondeoMs: 30 });
      const registro = crearRegistro<Ctx>([
        p.proveedor as never,
        {
          nombre: "app",
          capacidades: [
            { id: "cobro.confirmar", nombre: "Confirmar", tipo: "accion" },
            { id: "cobro.aprobado", nombre: "Aprobado", tipo: "condicion", evaluar: (_x, c) => c.aprobado },
            { id: "cobro.avisar", nombre: "Avisar", tipo: "efecto" },
          ],
        },
      ]);
      let estado = "esperando";
      const avisar = vi.fn(async () => undefined);
      const ejecutor = crearEjecutor<Ctx>({
        registro,
        almacen: crearAlmacenPostgres(api),
        objetivos: async () => [{ flujo, id: "cobro-1", instancia: { version: 1, estado }, contexto: { aprobado: true } }],
        aplicarTransicion: async ({ plan }) => void (estado = plan.destino),
        efectos: { "cobro.avisar": avisar },
      });
      await p.sincronizar!(suscripciones(flujo));
      await api.query("INSERT INTO public.pagos (estado) VALUES ('pendiente')");
      let entregado: EventoEntrante | undefined;
      const detener = await p.escuchar!(async (e) => {
        entregado = e;
        await ejecutor.procesar(e);
      });
      await api.query("UPDATE public.pagos SET estado = 'acreditado'");
      await hasta(() => estado === "cobrado");
      await hasta(() => avisar.mock.calls.length === 1);
      await detener();
      expect((await ejecutor.procesar(entregado!))[0]!.estado).toBe("repetido");
      expect(avisar).toHaveBeenCalledTimes(1);
    });

    it("corta un bucle: un efecto que reescribe la tabla termina en fallidos por tope de cadena", async () => {
      const bucle: DefinicionFlujo = {
        id: "bucle",
        version: 1,
        nombre: "Bucle",
        estadoInicial: "a",
        estados: [{ id: "a", nombre: "A", final: true }],
        transiciones: [],
        reacciones: [{ id: "r", evento: EVENTOS.UPDATE, params: { tabla: "public.pagos", campos: ["monto"] }, desde: ["a"], efectos: [{ efecto: "bucle.sumar" }] }],
      };
      const p = plugin({ sondeoMs: 20 });
      const registro = crearRegistro<Record<string, unknown>>([p.proveedor, { nombre: "app", capacidades: [{ id: "bucle.sumar", nombre: "Sumar", tipo: "efecto" }] }]);
      const almacen = crearAlmacenPostgres(api);
      const sumar = vi.fn(async ({ cadena }: { cadena: { raiz: string; profundidad: number } }) => {
        await conCadena(apiUna, cadena, () => apiUna.query("UPDATE public.pagos SET monto = monto + 1"));
      });
      const ejecutor = crearEjecutor({
        registro,
        almacen,
        topeCadena: 3,
        objetivos: async () => [{ flujo: bucle, id: "b1", instancia: { version: 1, estado: "a" }, contexto: {} }],
        aplicarTransicion: async () => undefined,
        efectos: { "bucle.sumar": sumar as never },
      });
      await p.sincronizar!(suscripciones(bucle));
      await api.query("INSERT INTO public.pagos (monto) VALUES (0)");
      const detener = await p.escuchar!(async (e) => void (await ejecutor.procesar(e)));
      await api.query("UPDATE public.pagos SET monto = 1");
      await hasta(async () => (await almacen.fallidos()).some((f) => f.motivo === "tope_de_cadena"), 6000);
      await detener();
      expect(sumar).toHaveBeenCalledTimes(3);
    }, 10000);
  });
});
