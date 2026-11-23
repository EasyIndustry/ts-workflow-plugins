import { type DefinicionFlujo, type Suscripcion } from "ts-workflow-core";
/**
 * Las suscripciones que hay que mantener: las de la última versión de cada flujo y las de toda versión vieja que todavía
 * tenga instancias activas. `versionesActivas` es, por id de flujo, las versiones con instancias sin terminar.
 */
export declare function suscripcionesNecesarias(versiones: readonly DefinicionFlujo[], versionesActivas: Readonly<Record<string, readonly number[]>>): Suscripcion[];
