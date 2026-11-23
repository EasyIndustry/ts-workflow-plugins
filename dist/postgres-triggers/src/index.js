import { definirPlugin } from "../../nucleo/src/index.js";
import { CANAL, SQL_INSTALACION } from "./sql.js";
import { deseadasDe, esquemaDeEvento, eventosDeFila, EVENTOS, ID_PLUGIN, partirTabla, validarPermitidas } from "./suscripciones.js";
export { CANAL, SQL_INSTALACION } from "./sql.js";
export { EVENTOS } from "./suscripciones.js";
export const ficha = { id: ID_PLUGIN, version: "0.1.0", permisos: ["db:lectura", "db:escritura", "db:ddl"] };
/** Instala el esquema `flujo`. Se corre una vez, en una migración, con un rol administrador. Es idempotente. */
export async function instalar(admin) {
    await admin.query(SQL_INSTALACION);
}
/** Registra la lista permitida en la base y da los permisos mínimos al rol de la API. Con un rol administrador. */
export async function autorizar(admin, permitidas, rolApi) {
    validarPermitidas(permitidas);
    for (const [nombre, campos] of Object.entries(permitidas)) {
        const { esquema, tabla } = partirTabla(nombre);
        await admin.query("SELECT flujo.permitir(format('%I.%I', $1::text, $2::text)::regclass, $3::text[])", [esquema, tabla, [...campos]]);
    }
    await admin.query("SELECT flujo.conceder_api(quote_ident($1::text)::regrole)", [rolApi]);
}
/**
 * Corre `hacer` en una transacción marcando la cadena de causas: los eventos que provoque heredan la cadena y así se
 * corta un bucle. `cliente` tiene que ser una conexión única (no un pool).
 */
export async function conCadena(cliente, cadena, hacer) {
    await cliente.query("BEGIN");
    try {
        await cliente.query("SELECT set_config('flujo.cadena', $1, true)", [`${cadena.raiz}|${cadena.profundidad}`]);
        const resultado = await hacer();
        await cliente.query("COMMIT");
        return resultado;
    }
    catch (error) {
        await cliente.query("ROLLBACK");
        throw error;
    }
}
export function crearPluginPostgresTriggers(opciones) {
    const { cliente, permitidas, conexionEscucha } = opciones;
    validarPermitidas(permitidas);
    const sondeoMs = opciones.sondeoMs ?? 5000;
    const lote = opciones.lote ?? 50;
    const reservaSegundos = opciones.reservaSegundos ?? 60;
    const maxEntregas = opciones.maxEntregas ?? 5;
    const alError = opciones.alError ?? (() => undefined);
    const evento = (id, nombre, conCampos) => ({ id, nombre, tipo: "evento", grupo: "Base de datos", schemaEntrada: esquemaDeEvento(permitidas, conCampos) });
    async function sincronizar(suscripciones) {
        const deseadas = deseadasDe(suscripciones, permitidas);
        const { rows } = await cliente.query("SELECT flujo.reconciliar($1::jsonb, $2::boolean) AS r", [JSON.stringify(deseadas), opciones.permitirVaciar === true]);
        return rows[0].r;
    }
    async function procesarFila(fila, subs, cb) {
        try {
            for (const e of eventosDeFila(fila, subs))
                await cb(e);
            await cliente.query("SELECT flujo.confirmar($1::bigint)", [fila.id]);
        }
        catch (error) {
            const texto = error instanceof Error ? error.message : String(error);
            alError(error);
            if (fila.intentos >= maxEntregas)
                await cliente.query("SELECT flujo.fallar($1::bigint, $2::text)", [fila.id, texto]);
            else
                await cliente.query("SELECT flujo.devolver($1::bigint, $2::integer, $3::text)", [fila.id, Math.min(2 ** fila.intentos, 60), texto]);
        }
    }
    async function escuchar(cb) {
        let activo = true;
        let otraVuelta = false;
        let enCurso = null;
        const vaciar = async () => {
            do {
                otraVuelta = false;
                while (activo) {
                    const { rows } = await cliente.query("SELECT * FROM flujo.tomar($1::integer, $2::integer)", [lote, reservaSegundos]);
                    if (!rows.length)
                        break;
                    const filas = rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
                    const { rows: subs } = await cliente.query("SELECT clave, evento, esquema, tabla, operacion, campos, params FROM flujo.suscripciones");
                    for (const fila of filas) {
                        if (!activo) {
                            // Lo tomado y no procesado se devuelve ya, sin esperar a que venza la reserva.
                            await cliente.query("SELECT flujo.devolver($1::bigint, 0, 'detenido')", [fila.id]);
                            continue;
                        }
                        await procesarFila(fila, subs, cb);
                    }
                }
            } while (otraVuelta && activo);
        };
        const despertar = () => {
            if (!activo)
                return;
            if (enCurso) {
                otraVuelta = true;
                return;
            }
            enCurso = vaciar()
                .catch(alError)
                .finally(() => {
                enCurso = null;
                if (otraVuelta && activo)
                    despertar();
            });
        };
        const alNotificar = (m) => {
            if (m.channel === CANAL)
                despertar();
        };
        if (conexionEscucha) {
            conexionEscucha.on("notification", alNotificar);
            await conexionEscucha.query(`LISTEN ${CANAL}`);
        }
        const reloj = setInterval(despertar, sondeoMs);
        despertar();
        return async () => {
            activo = false;
            clearInterval(reloj);
            if (conexionEscucha) {
                conexionEscucha.off("notification", alNotificar);
                await conexionEscucha.query(`UNLISTEN ${CANAL}`);
            }
            if (enCurso)
                await enCurso;
        };
    }
    return definirPlugin({
        id: ficha.id,
        version: ficha.version,
        permisos: ficha.permisos,
        eventos: [
            evento(EVENTOS.INSERT, "Se insertó una fila", false),
            evento(EVENTOS.UPDATE, "Se actualizó una fila", true),
            evento(EVENTOS.DELETE, "Se borró una fila", false),
        ],
        sincronizar,
        escuchar,
    });
}
/** Almacén durable del ejecutor, en las tablas de `flujo`. */
export function crearAlmacenPostgres(cliente) {
    return {
        async leerPlan(clave) {
            const { rows } = await cliente.query("SELECT plan FROM flujo.planes WHERE clave = $1", [clave]);
            return rows[0]?.plan ?? null;
        },
        async fijarPlan(clave, plan) {
            await cliente.query("INSERT INTO flujo.planes (clave, plan) VALUES ($1, $2::jsonb) ON CONFLICT (clave) DO NOTHING", [clave, JSON.stringify(plan)]);
            const { rows } = await cliente.query("SELECT plan FROM flujo.planes WHERE clave = $1", [clave]);
            return rows[0].plan;
        },
        async pasoHecho(clave) {
            return (await cliente.query("SELECT 1 FROM flujo.pasos WHERE clave = $1", [clave])).rows.length > 0;
        },
        async marcarPaso(clave) {
            await cliente.query("INSERT INTO flujo.pasos (clave) VALUES ($1) ON CONFLICT (clave) DO NOTHING", [clave]);
        },
        async agregarFallido(f) {
            await cliente.query("INSERT INTO flujo.fallidos (clave, datos) VALUES ($1, $2::jsonb) ON CONFLICT (clave) DO UPDATE SET datos = excluded.datos", [f.clave, JSON.stringify(f)]);
        },
        async fallidos() {
            return (await cliente.query("SELECT datos FROM flujo.fallidos ORDER BY creado")).rows.map((r) => r.datos);
        },
        async quitarFallido(clave) {
            await cliente.query("DELETE FROM flujo.fallidos WHERE clave = $1", [clave]);
        },
    };
}
//# sourceMappingURL=index.js.map