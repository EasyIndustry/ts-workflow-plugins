import type { EsquemaJson } from "ts-workflow-core";
/**
 * Leer una especificación OpenAPI 3 y sacar de ella las operaciones, cada una con el schema de lo que recibe. Puro: no
 * hace pedidos ni sabe de quién es la API.
 */
export declare const ID_PLUGIN = "openapi";
export declare const METODOS: readonly ["get", "post", "put", "patch", "delete"];
export type Metodo = (typeof METODOS)[number];
export interface Operacion {
    /** Estable: el `operationId` de la especificación o, si no tiene, uno armado con el método y la ruta. */
    readonly id: string;
    /** El id de la capacidad en el registro: `openapi.<id>`. */
    readonly capacidad: string;
    readonly metodo: Metodo;
    /** La ruta tal como está en la especificación, con sus `{parametros}`. */
    readonly ruta: string;
    readonly nombre: string;
    readonly descripcion?: string | undefined;
    /** La primera etiqueta (`tags`) de la operación, para agrupar. */
    readonly grupo?: string | undefined;
    readonly parametrosDeRuta: readonly string[];
    readonly parametrosDeConsulta: readonly string[];
    readonly tieneCuerpo: boolean;
    /** Lo que recibe: `ruta`, `consulta` y `cuerpo`, cada uno solo si la operación lo usa. Sin `$ref`: ya resueltos. */
    readonly schemaEntrada: EsquemaJson;
}
export declare class ErrorEspecificacion extends Error {
    constructor(mensaje: string);
}
/** El id de una operación sin `operationId`: «post-pedidos-id-cerrar» para `POST /pedidos/{id}/cerrar`. */
export declare function idDeOperacion(metodo: string, ruta: string): string;
/** Todas las operaciones de la especificación, en el orden en que están. Falla si no es OpenAPI 3 o si dos quedan con el mismo id. */
export declare function operacionesDe(especificacion: unknown): Operacion[];
