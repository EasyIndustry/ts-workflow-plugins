import { type Almacen, type Cadena, type Permiso, type Plugin } from "../../nucleo/src/index.js";
import { type Permitidas } from "./suscripciones.js";
export { CANAL, SQL_INSTALACION } from "./sql.js";
export { EVENTOS, type Permitidas } from "./suscripciones.js";
export declare const ficha: {
    readonly id: "postgres-triggers";
    readonly version: "0.1.0";
    readonly permisos: readonly Permiso[];
};
/** Lo único que el plugin necesita de un cliente: `pg.Pool` y `pg.Client` lo cumplen. El plugin no depende de `pg`. */
export interface ClienteSql {
    query(texto: string, valores?: unknown[]): Promise<{
        rows: any[];
    }>;
}
/** Una conexión dedicada para LISTEN (un `pg.Client`, no un pool). */
export interface ConexionEscucha extends ClienteSql {
    on(evento: "notification", cb: (mensaje: {
        channel: string;
    }) => void): unknown;
    off(evento: "notification", cb: (mensaje: {
        channel: string;
    }) => void): unknown;
}
export interface OpcionesPlugin {
    /** Conexión con el rol de la API (sin DDL). */
    readonly cliente: ClienteSql;
    readonly permitidas: Permitidas;
    /** Si no está, se trabaja solo con el sondeo. NOTIFY es un despertador: la fuente de verdad es el outbox. */
    readonly conexionEscucha?: ConexionEscucha;
    /** Cada cuánto se revisa el outbox aunque no llegue un NOTIFY. Por defecto 5000 ms. */
    readonly sondeoMs?: number;
    readonly lote?: number;
    /** Cuánto dura la reserva de una fila mientras se procesa. Por defecto 60 s. */
    readonly reservaSegundos?: number;
    /** Entregas de una fila antes de marcarla como fallida. Por defecto 5. */
    readonly maxEntregas?: number;
    /** Permite que una lista de suscripciones vacía borre todos los triggers. Por defecto no. */
    readonly permitirVaciar?: boolean;
    readonly alError?: (error: unknown) => void;
}
/** Instala el esquema `flujo`. Se corre una vez, en una migración, con un rol administrador. Es idempotente. */
export declare function instalar(admin: ClienteSql): Promise<void>;
/** Registra la lista permitida en la base y da los permisos mínimos al rol de la API. Con un rol administrador. */
export declare function autorizar(admin: ClienteSql, permitidas: Permitidas, rolApi: string): Promise<void>;
/**
 * Corre `hacer` en una transacción marcando la cadena de causas: los eventos que provoque heredan la cadena y así se
 * corta un bucle. `cliente` tiene que ser una conexión única (no un pool).
 */
export declare function conCadena<T>(cliente: ClienteSql, cadena: Cadena, hacer: () => Promise<T>): Promise<T>;
export declare function crearPluginPostgresTriggers<C = Record<string, unknown>>(opciones: OpcionesPlugin): Plugin<C>;
/** Almacén durable del ejecutor, en las tablas de `flujo`. */
export declare function crearAlmacenPostgres(cliente: ClienteSql): Almacen;
