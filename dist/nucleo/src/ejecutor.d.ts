import { type FuenteFlujo, type Instancia, type PlanReaccion, type Registro } from "ts-workflow-core";
import type { Cadena, EjecutarEfecto, EventoEntrante } from "./contrato.js";
/**
 * El ejecutor común de reacciones: recibe un evento, pide el plan al core y lo ejecuta con reintentos, idempotencia, un
 * tope de bucles por cadena de causas y una cola de fallidos.
 *
 * Garantía: al menos una vez por paso. Un paso confirmado no se repite; si el proceso se cae entre hacerlo y confirmarlo,
 * se repite con la misma `clave`, y la implementación la usa para no duplicar el trabajo.
 */
/** Una instancia a la que le llega el evento, con el contexto ya cargado por la app. */
export interface Objetivo<C> {
    readonly flujo: FuenteFlujo;
    /** Identifica la instancia en la app. */
    readonly id: string;
    readonly instancia: Instancia;
    readonly contexto: C;
}
export interface Fallido {
    readonly clave: string;
    readonly evento: EventoEntrante;
    readonly flujo: string;
    readonly instancia: string;
    readonly plan: PlanReaccion | null;
    readonly paso: string;
    readonly motivo: "reintentos_agotados" | "error_definitivo" | "tope_de_cadena" | "plan_invalido";
    readonly error: string;
    readonly intentos: number;
}
/** Dónde se guarda el avance. Tiene que ser durable para que la idempotencia sobreviva a un reinicio. */
export interface Almacen {
    /** El plan guardado de un intento anterior, si lo hay. */
    leerPlan(clave: string): Promise<PlanReaccion | null>;
    /** Guarda el plan si no había uno y devuelve el que quedó: gana el primero. */
    fijarPlan(clave: string, plan: PlanReaccion): Promise<PlanReaccion>;
    pasoHecho(clave: string): Promise<boolean>;
    marcarPaso(clave: string): Promise<void>;
    agregarFallido(fallido: Fallido): Promise<void>;
    fallidos(): Promise<Fallido[]>;
    quitarFallido(clave: string): Promise<void>;
}
/** Un error que no se arregla reintentando (por ejemplo, datos inválidos): va directo a la cola de fallidos. */
export declare class ErrorDefinitivo extends Error {
    constructor(mensaje: string, opciones?: {
        cause?: unknown;
    });
}
export interface OpcionesEjecutor<C> {
    readonly registro: Registro<C>;
    readonly almacen: Almacen;
    /** Qué instancias reciben este evento. Si falla, `procesar` falla y quien entrega el evento lo vuelve a entregar. */
    objetivos(evento: EventoEntrante): Promise<readonly Objetivo<C>[]>;
    /** Hace la transición en la app: persiste el estado. Tiene que ser idempotente por `clave`. */
    aplicarTransicion(entrada: {
        clave: string;
        plan: PlanReaccion;
        evento: EventoEntrante;
        instancia: string;
        cadena: Cadena;
    }): Promise<void>;
    /** Implementación de cada efecto, por id de capacidad. */
    readonly efectos: Readonly<Record<string, EjecutarEfecto>>;
    /** Intentos por paso, contando el primero. Por defecto 3. */
    readonly maxIntentos?: number;
    /** Espera antes del primer reintento; se duplica en cada uno. Por defecto 200 ms. */
    readonly esperaMs?: number;
    /** Cuántos saltos puede tener una cadena de causas. Por defecto 8. */
    readonly topeCadena?: number;
    readonly dormir?: (ms: number) => Promise<void>;
}
export type EstadoResultado = "aplicado" | "sin_reaccion" | "no_aplica" | "repetido" | "fallido";
export interface ResultadoObjetivo {
    readonly instancia: string;
    readonly estado: EstadoResultado;
    readonly plan: PlanReaccion | null;
    readonly motivos?: readonly string[];
}
export interface Ejecutor {
    procesar(evento: EventoEntrante): Promise<ResultadoObjetivo[]>;
    /** Reintenta un fallido desde el paso donde quedó. Si vuelve a fallar, sigue en la cola. */
    reintentarFallido(clave: string): Promise<ResultadoObjetivo>;
}
export declare function crearEjecutor<C>(opciones: OpcionesEjecutor<C>): Ejecutor;
/** Almacén en memoria, para tests y para probar. No sobrevive a un reinicio: en producción usá uno durable. */
export declare function crearAlmacenMemoria(): Almacen;
