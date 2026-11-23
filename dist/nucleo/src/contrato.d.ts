import type { CapacidadCondicion, DescriptorCapacidad, Proveedor, Suscripcion } from "ts-workflow-core";
/**
 * El contrato de un plugin. Un plugin aporta capacidades al registro del core y, si trae eventos, sabe escucharlos.
 * No decide nada: las decisiones son de `reaccionar` (core) y la ejecución del ejecutor común.
 */
export declare const PERMISOS: readonly ["db:lectura", "db:escritura", "db:ddl", "red", "archivos", "procesos"];
export type Permiso = (typeof PERMISOS)[number];
/** Una cadena de causas: de qué evento original viene este y a cuántos saltos está. Corta los bucles. */
export interface Cadena {
    readonly raiz: string;
    readonly profundidad: number;
}
/** Un evento tal como lo entrega un plugin. `id` es único y estable: si se entrega dos veces, se ejecuta una. */
export interface EventoEntrante {
    readonly id: string;
    readonly evento: string;
    readonly params?: Record<string, unknown> | undefined;
    readonly datos?: unknown;
    readonly cadena?: Cadena | undefined;
}
export type Detener = () => Promise<void>;
/** Lo que recibe la implementación de un efecto. `clave` es estable entre reintentos: usala para no repetir el trabajo. */
export interface EntradaEfecto {
    readonly clave: string;
    readonly params: Record<string, unknown>;
    readonly evento: EventoEntrante;
    readonly flujo: string;
    readonly instancia: string;
    /** La cadena que tiene que heredar lo que este efecto provoque. */
    readonly cadena: Cadena;
}
export type EjecutarEfecto = (entrada: EntradaEfecto) => Promise<void>;
export interface EfectoDePlugin extends DescriptorCapacidad {
    readonly tipo: "efecto";
    ejecutar: EjecutarEfecto;
}
export interface EventoDePlugin extends DescriptorCapacidad {
    readonly tipo: "evento";
}
export interface ResultadoSincronizacion {
    readonly creados: readonly string[];
    readonly borrados: readonly string[];
    readonly conservados: readonly string[];
}
export interface DefinicionPlugin<C = Record<string, unknown>> {
    readonly id: string;
    readonly version: string;
    readonly permisos: readonly Permiso[];
    readonly eventos?: readonly EventoDePlugin[];
    readonly condiciones?: readonly CapacidadCondicion<C>[];
    readonly efectos?: readonly EfectoDePlugin[];
    /** Deja el sistema escuchando exactamente estas suscripciones. Idempotente. */
    sincronizar?(suscripciones: readonly Suscripcion[]): Promise<ResultadoSincronizacion>;
    /** Empieza a entregar eventos. Si `cb` falla, el evento se vuelve a entregar. */
    escuchar?(cb: (evento: EventoEntrante) => Promise<void>): Promise<Detener>;
}
export interface Plugin<C = Record<string, unknown>> extends DefinicionPlugin<C> {
    readonly eventos: readonly EventoDePlugin[];
    readonly condiciones: readonly CapacidadCondicion<C>[];
    readonly efectos: readonly EfectoDePlugin[];
    /** Las capacidades del plugin, listas para `crearRegistro`. */
    readonly proveedor: Proveedor<C>;
}
export declare class ErrorPlugin extends Error {
    constructor(mensaje: string);
}
/** Valida la declaración y la congela. Falla al arrancar, no cuando llega el primer evento. */
export declare function definirPlugin<C = Record<string, unknown>>(definicion: DefinicionPlugin<C>): Plugin<C>;
/** Junta los efectos de varios plugins en el mapa que recibe el ejecutor. */
export declare function efectosDe<C>(plugins: readonly Plugin<C>[]): Record<string, EjecutarEfecto>;
