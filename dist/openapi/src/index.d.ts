import { type Permiso, type Plugin } from "../../nucleo/src/index.js";
export { ErrorEspecificacion, idDeOperacion, METODOS, operacionesDe, type Metodo, type Operacion } from "./especificacion.js";
export declare const ficha: {
    readonly id: "openapi";
    readonly version: "0.1.0";
    readonly permisos: readonly Permiso[];
};
export interface Permitida {
    readonly id: string;
    readonly nombre?: string;
    readonly descripcion?: string;
}
export interface OpcionesPlugin {
    /** El documento OpenAPI 3 de la API, ya leído (un objeto). De dónde sale lo decide la app. */
    readonly especificacion: unknown;
    /** La dirección de la API. Los pedidos solo van ahí: nada de lo que venga en una definición la cambia. */
    readonly urlBase: string;
    /**
     * Las operaciones que los flujos pueden usar. Por defecto, ninguna: se exponen a propósito. Cada una es su id o, para
     * darle el nombre con el que la va a ver una persona, un objeto: muchas especificaciones no traen `summary`.
     */
    readonly permitidas?: readonly (string | Permitida)[];
    /**
     * La credencial de servicio con la que el flujo se presenta ante la API, para el encabezado `Authorization`. Es la
     * identidad del flujo: lo que ese usuario puede hacer es el tope de lo que puede hacer cualquier flujo. La inyecta la app.
     */
    readonly credencial?: () => string | Promise<string>;
    /** Para probar o para un entorno sin `fetch` global. */
    readonly fetch?: typeof fetch;
    /** Cuánto esperar una respuesta. Por defecto 15000 ms. */
    readonly tiempoMs?: number;
}
/**
 * Convierte operaciones de una API descrita con OpenAPI 3 en efectos del registro. Así un flujo escribe a través de la
 * API del sistema, con sus permisos y sus reglas, y no directo en la base.
 */
export declare function crearPluginOpenApi(opciones: OpcionesPlugin): Plugin;
