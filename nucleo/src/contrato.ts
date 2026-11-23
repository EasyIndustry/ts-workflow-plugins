import type { CapacidadCondicion, DescriptorCapacidad, Proveedor, Suscripcion } from "ts-workflow-core";

/**
 * El contrato de un plugin. Un plugin aporta capacidades al registro del core y, si trae eventos, sabe escucharlos.
 * No decide nada: las decisiones son de `reaccionar` (core) y la ejecución del ejecutor común.
 */

export const PERMISOS = ["db:lectura", "db:escritura", "db:ddl", "red", "archivos", "procesos"] as const;
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

export class ErrorPlugin extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorPlugin";
  }
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

/** Valida la declaración y la congela. Falla al arrancar, no cuando llega el primer evento. */
export function definirPlugin<C = Record<string, unknown>>(definicion: DefinicionPlugin<C>): Plugin<C> {
  const { id, version, permisos } = definicion;
  if (typeof id !== "string" || !ID.test(id)) throw new ErrorPlugin(`Id de plugin inválido: «${String(id)}». Usá minúsculas, números y guiones.`);
  if (typeof version !== "string" || !SEMVER.test(version)) throw new ErrorPlugin(`${id}: la versión «${String(version)}» no es semver.`);
  if (!Array.isArray(permisos)) throw new ErrorPlugin(`${id}: faltan los permisos (una lista, aunque sea vacía).`);
  for (const p of permisos) if (!PERMISOS.includes(p)) throw new ErrorPlugin(`${id}: permiso desconocido «${String(p)}».`);

  const eventos = definicion.eventos ?? [];
  const condiciones = definicion.condiciones ?? [];
  const efectos = definicion.efectos ?? [];
  const vistos = new Set<string>();
  const revisar = (c: DescriptorCapacidad, tipo: DescriptorCapacidad["tipo"]) => {
    if (c.tipo !== tipo) throw new ErrorPlugin(`${id}: «${c.id}» está declarada como ${tipo} pero es de tipo ${c.tipo}.`);
    if (!c.id.startsWith(`${id}.`)) throw new ErrorPlugin(`${id}: la capacidad «${c.id}» tiene que empezar con «${id}.».`);
    if (vistos.has(c.id)) throw new ErrorPlugin(`${id}: la capacidad «${c.id}» está dos veces.`);
    vistos.add(c.id);
  };
  eventos.forEach((c) => revisar(c, "evento"));
  condiciones.forEach((c) => revisar(c, "condicion"));
  efectos.forEach((c) => {
    revisar(c, "efecto");
    if (typeof c.ejecutar !== "function") throw new ErrorPlugin(`${id}: el efecto «${c.id}» no tiene la función ejecutar.`);
  });
  if (eventos.length && (!definicion.sincronizar || !definicion.escuchar)) {
    throw new ErrorPlugin(`${id}: un plugin con eventos necesita sincronizar y escuchar.`);
  }

  const capacidades = [...eventos, ...condiciones, ...efectos.map(({ ejecutar: _ejecutar, ...descriptor }) => descriptor)];
  return Object.freeze({
    ...definicion,
    permisos: Object.freeze([...permisos]),
    eventos: Object.freeze([...eventos]),
    condiciones: Object.freeze([...condiciones]),
    efectos: Object.freeze([...efectos]),
    proveedor: Object.freeze({ nombre: `plugin ${id}`, capacidades }),
  }) as Plugin<C>;
}

/** Junta los efectos de varios plugins en el mapa que recibe el ejecutor. */
export function efectosDe<C>(plugins: readonly Plugin<C>[]): Record<string, EjecutarEfecto> {
  return Object.fromEntries(plugins.flatMap((p) => p.efectos.map((e) => [e.id, e.ejecutar])));
}
