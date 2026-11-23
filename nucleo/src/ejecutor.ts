import { huella, reaccionar, type FuenteFlujo, type Instancia, type PlanReaccion, type Registro } from "ts-workflow-core";
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
export class ErrorDefinitivo extends Error {
  constructor(mensaje: string, opciones?: { cause?: unknown }) {
    super(mensaje, opciones);
    this.name = "ErrorDefinitivo";
  }
}

export interface OpcionesEjecutor<C> {
  readonly registro: Registro<C>;
  readonly almacen: Almacen;
  /** Qué instancias reciben este evento. Si falla, `procesar` falla y quien entrega el evento lo vuelve a entregar. */
  objetivos(evento: EventoEntrante): Promise<readonly Objetivo<C>[]>;
  /** Hace la transición en la app: persiste el estado. Tiene que ser idempotente por `clave`. */
  aplicarTransicion(entrada: { clave: string; plan: PlanReaccion; evento: EventoEntrante; instancia: string; cadena: Cadena }): Promise<void>;
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

export function crearEjecutor<C>(opciones: OpcionesEjecutor<C>): Ejecutor {
  const { registro, almacen, objetivos, aplicarTransicion, efectos } = opciones;
  const maxIntentos = opciones.maxIntentos ?? 3;
  const esperaMs = opciones.esperaMs ?? 200;
  const topeCadena = opciones.topeCadena ?? 8;
  const dormir = opciones.dormir ?? ((ms: number) => new Promise<void>((listo) => setTimeout(listo, ms)));

  const cadenaDe = (evento: EventoEntrante): Cadena => evento.cadena ?? { raiz: evento.id, profundidad: 0 };

  async function conReintentos(hacer: () => Promise<void>): Promise<{ error: unknown; definitivo: boolean; intentos: number } | null> {
    for (let intento = 1; ; intento++) {
      try {
        await hacer();
        return null;
      } catch (error) {
        const definitivo = error instanceof ErrorDefinitivo;
        if (definitivo || intento >= maxIntentos) return { error, definitivo, intentos: intento };
        await dormir(esperaMs * 2 ** (intento - 1));
      }
    }
  }

  /** Corre los pasos que falten. La transición va primero: si no se pudo, los efectos no salen. */
  async function ejecutarPlan(clave: string, plan: PlanReaccion, evento: EventoEntrante, instancia: string): Promise<ResultadoObjetivo> {
    const cadena = cadenaDe(evento);
    const siguiente: Cadena = { raiz: cadena.raiz, profundidad: cadena.profundidad + 1 };
    const pasos: { nombre: string; hacer: (claveDePaso: string) => Promise<void> }[] = [];
    if (plan.transicion !== undefined) {
      pasos.push({ nombre: `transicion:${plan.transicion}`, hacer: (c) => aplicarTransicion({ clave: c, plan, evento, instancia, cadena: siguiente }) });
    }
    plan.efectos.forEach((e, i) => {
      pasos.push({
        nombre: `efecto:${i}:${e.efecto}`,
        hacer: async (c) => {
          const ejecutar = Object.hasOwn(efectos, e.efecto) ? efectos[e.efecto] : undefined;
          if (!ejecutar) throw new ErrorDefinitivo(`No hay implementación para el efecto «${e.efecto}».`);
          await ejecutar({ clave: c, params: e.params, evento, flujo: plan.flujo, instancia, cadena: siguiente });
        },
      });
    });

    for (const paso of pasos) {
      const claveDePaso = huella({ clave, paso: paso.nombre });
      if (await almacen.pasoHecho(claveDePaso)) continue;
      const fallo = await conReintentos(() => paso.hacer(claveDePaso));
      if (fallo) {
        await almacen.agregarFallido({
          clave,
          evento,
          flujo: plan.flujo,
          instancia,
          plan,
          paso: paso.nombre,
          motivo: fallo.definitivo ? "error_definitivo" : "reintentos_agotados",
          error: mensajeDe(fallo.error),
          intentos: fallo.intentos,
        });
        return { instancia, estado: "fallido", plan };
      }
      await almacen.marcarPaso(claveDePaso);
    }
    await almacen.marcarPaso(claveFin(clave));
    await almacen.quitarFallido(clave);
    return { instancia, estado: "aplicado", plan };
  }

  async function procesarObjetivo(evento: EventoEntrante, objetivo: Objetivo<C>): Promise<ResultadoObjetivo> {
    const clave = huella({ evento: evento.id, instancia: objetivo.id });
    const flujoId = idDeFlujo(objetivo.flujo);
    if (await almacen.pasoHecho(claveFin(clave))) return { instancia: objetivo.id, estado: "repetido", plan: null };

    const cadena = cadenaDe(evento);
    if (cadena.profundidad >= topeCadena) {
      await almacen.agregarFallido({
        clave,
        evento,
        flujo: flujoId,
        instancia: objetivo.id,
        plan: null,
        paso: "cadena",
        motivo: "tope_de_cadena",
        error: `La cadena «${cadena.raiz}» llegó a ${cadena.profundidad} saltos (tope ${topeCadena}): parece un bucle.`,
        intentos: 0,
      });
      return { instancia: objetivo.id, estado: "fallido", plan: null };
    }

    // Si hubo un intento anterior manda su plan: esa misma ejecución pudo haber cambiado el estado de la instancia.
    const guardado = await almacen.leerPlan(clave);
    if (guardado) return guardado.aplica ? ejecutarPlan(clave, guardado, evento, objetivo.id) : { instancia: objetivo.id, estado: "no_aplica", plan: guardado, motivos: guardado.motivos };

    let calculado: PlanReaccion | null;
    try {
      calculado = reaccionar(objetivo.flujo, objetivo.instancia, { evento: evento.evento, params: evento.params ?? {} }, objetivo.contexto, registro);
    } catch (error) {
      await almacen.agregarFallido({ clave, evento, flujo: flujoId, instancia: objetivo.id, plan: null, paso: "plan", motivo: "plan_invalido", error: mensajeDe(error), intentos: 1 });
      return { instancia: objetivo.id, estado: "fallido", plan: null };
    }
    if (!calculado) return { instancia: objetivo.id, estado: "sin_reaccion", plan: null };

    const plan = await almacen.fijarPlan(clave, calculado);
    if (!plan.aplica) {
      await almacen.marcarPaso(claveFin(clave));
      return { instancia: objetivo.id, estado: "no_aplica", plan, motivos: plan.motivos };
    }
    return ejecutarPlan(clave, plan, evento, objetivo.id);
  }

  return {
    async procesar(evento) {
      const lista = await objetivos(evento);
      const resultados: ResultadoObjetivo[] = [];
      for (const objetivo of lista) resultados.push(await procesarObjetivo(evento, objetivo));
      return resultados;
    },
    async reintentarFallido(clave) {
      const fallido = (await almacen.fallidos()).find((f) => f.clave === clave);
      if (!fallido) throw new Error(`No hay un fallido con la clave «${clave}».`);
      if (!fallido.plan) throw new ErrorDefinitivo(`El fallido «${clave}» no llegó a tener plan (${fallido.motivo}): hay que volver a entregar el evento.`);
      await almacen.quitarFallido(clave);
      return ejecutarPlan(clave, fallido.plan, fallido.evento, fallido.instancia);
    },
  };
}

const claveFin = (clave: string) => huella({ clave, paso: "fin" });
const mensajeDe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const idDeFlujo = (flujo: FuenteFlujo) => (Array.isArray(flujo) ? (flujo as readonly { id: string }[])[0]?.id ?? "" : (flujo as { id: string }).id);

/** Almacén en memoria, para tests y para probar. No sobrevive a un reinicio: en producción usá uno durable. */
export function crearAlmacenMemoria(): Almacen {
  const planes = new Map<string, PlanReaccion>();
  const pasos = new Set<string>();
  const cola = new Map<string, Fallido>();
  return {
    leerPlan: async (clave) => planes.get(clave) ?? null,
    fijarPlan: async (clave, plan) => {
      if (!planes.has(clave)) planes.set(clave, plan);
      return planes.get(clave)!;
    },
    pasoHecho: async (clave) => pasos.has(clave),
    marcarPaso: async (clave) => void pasos.add(clave),
    agregarFallido: async (f) => void cola.set(f.clave, f),
    fallidos: async () => [...cola.values()],
    quitarFallido: async (clave) => void cola.delete(clave),
  };
}
