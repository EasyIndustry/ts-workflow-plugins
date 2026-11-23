import { type Cadena, type EventoEntrante } from "../../nucleo/src/index.js";
import type { Suscripcion } from "ts-workflow-core";
export declare const ID_PLUGIN = "postgres-triggers";
export declare const EVENTOS: {
    readonly INSERT: "postgres-triggers.fila-insertada";
    readonly UPDATE: "postgres-triggers.fila-actualizada";
    readonly DELETE: "postgres-triggers.fila-borrada";
};
export type Operacion = keyof typeof EVENTOS;
/** Qué se puede escuchar, por tabla («esquema.tabla»): sus campos. Lo que no esté acá no existe para las definiciones. */
export type Permitidas = Readonly<Record<string, readonly string[]>>;
export interface Deseada {
    clave: string;
    evento: string;
    esquema: string;
    tabla: string;
    operacion: Operacion;
    campos: string[] | null;
    params: Record<string, unknown>;
}
export declare const esIdentificador: (valor: unknown) => valor is string;
/** Parte «esquema.tabla». Falla con cualquier cosa que no sean dos identificadores simples. */
export declare function partirTabla(nombre: unknown): {
    esquema: string;
    tabla: string;
};
export declare function validarPermitidas(permitidas: Permitidas): void;
/**
 * Convierte las suscripciones de este plugin en lo que recibe `flujo.reconciliar`, validando contra la lista permitida.
 * Las de otros plugins se ignoran. La base vuelve a validar todo por su cuenta.
 */
export declare function deseadasDe(suscripciones: readonly Suscripcion[], permitidas: Permitidas): Deseada[];
/** El `schemaEntrada` de los eventos: un editor o `validarDefinicion` rechazan una tabla no permitida antes de llegar a la base. */
export declare function esquemaDeEvento(permitidas: Permitidas, conCampos: boolean): {
    type: string;
    properties: {
        campos?: {
            type: string;
            minItems: number;
            items: {
                type: string;
                enum: string[];
            };
        } | undefined;
        tabla: {
            type: string;
            enum: string[];
        };
    };
    required: string[];
    additionalProperties: boolean;
};
export interface FilaOutbox {
    id: string;
    esquema: string;
    tabla: string;
    operacion: Operacion;
    pk: Record<string, unknown>;
    antes: Record<string, unknown> | null;
    despues: Record<string, unknown> | null;
    cambiados: string[];
    cadena: string | null;
    intentos: number;
}
export interface FilaSuscripcion {
    clave: string;
    evento: string;
    esquema: string;
    tabla: string;
    operacion: Operacion;
    campos: string[] | null;
    params: Record<string, unknown>;
}
export declare function leerCadena(texto: string | null): Cadena | undefined;
/** Un evento por cada suscripción que coincide con la fila. El id es estable: una reentrega no se ejecuta dos veces. */
export declare function eventosDeFila(fila: FilaOutbox, suscripciones: readonly FilaSuscripcion[]): EventoEntrante[];
