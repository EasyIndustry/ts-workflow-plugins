import { huella, reaccionar } from "ts-workflow-core";
/** Un error que no se arregla reintentando (por ejemplo, datos inválidos): va directo a la cola de fallidos. */
export class ErrorDefinitivo extends Error {
    constructor(mensaje, opciones) {
        super(mensaje, opciones);
        this.name = "ErrorDefinitivo";
    }
}
export function crearEjecutor(opciones) {
    const { registro, almacen, objetivos, aplicarTransicion, efectos } = opciones;
    const maxIntentos = opciones.maxIntentos ?? 3;
    const esperaMs = opciones.esperaMs ?? 200;
    const topeCadena = opciones.topeCadena ?? 8;
    const dormir = opciones.dormir ?? ((ms) => new Promise((listo) => setTimeout(listo, ms)));
    const cadenaDe = (evento) => evento.cadena ?? { raiz: evento.id, profundidad: 0 };
    async function conReintentos(hacer) {
        for (let intento = 1;; intento++) {
            try {
                await hacer();
                return null;
            }
            catch (error) {
                const definitivo = error instanceof ErrorDefinitivo;
                if (definitivo || intento >= maxIntentos)
                    return { error, definitivo, intentos: intento };
                await dormir(esperaMs * 2 ** (intento - 1));
            }
        }
    }
    /** Corre los pasos que falten. La transición va primero: si no se pudo, los efectos no salen. */
    async function ejecutarPlan(clave, plan, evento, instancia) {
        const cadena = cadenaDe(evento);
        const siguiente = { raiz: cadena.raiz, profundidad: cadena.profundidad + 1 };
        const pasos = [];
        if (plan.transicion !== undefined) {
            pasos.push({ nombre: `transicion:${plan.transicion}`, hacer: (c) => aplicarTransicion({ clave: c, plan, evento, instancia, cadena: siguiente }) });
        }
        plan.efectos.forEach((e, i) => {
            pasos.push({
                nombre: `efecto:${i}:${e.efecto}`,
                hacer: async (c) => {
                    const ejecutar = Object.hasOwn(efectos, e.efecto) ? efectos[e.efecto] : undefined;
                    if (!ejecutar)
                        throw new ErrorDefinitivo(`No hay implementación para el efecto «${e.efecto}».`);
                    await ejecutar({ clave: c, params: e.params, evento, flujo: plan.flujo, instancia, cadena: siguiente });
                },
            });
        });
        for (const paso of pasos) {
            const claveDePaso = huella({ clave, paso: paso.nombre });
            if (await almacen.pasoHecho(claveDePaso))
                continue;
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
    async function procesarObjetivo(evento, objetivo) {
        const clave = huella({ evento: evento.id, instancia: objetivo.id });
        const flujoId = idDeFlujo(objetivo.flujo);
        if (await almacen.pasoHecho(claveFin(clave)))
            return { instancia: objetivo.id, estado: "repetido", plan: null };
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
        if (guardado)
            return guardado.aplica ? ejecutarPlan(clave, guardado, evento, objetivo.id) : { instancia: objetivo.id, estado: "no_aplica", plan: guardado, motivos: guardado.motivos };
        let calculado;
        try {
            calculado = reaccionar(objetivo.flujo, objetivo.instancia, { evento: evento.evento, params: evento.params ?? {} }, objetivo.contexto, registro);
        }
        catch (error) {
            await almacen.agregarFallido({ clave, evento, flujo: flujoId, instancia: objetivo.id, plan: null, paso: "plan", motivo: "plan_invalido", error: mensajeDe(error), intentos: 1 });
            return { instancia: objetivo.id, estado: "fallido", plan: null };
        }
        if (!calculado)
            return { instancia: objetivo.id, estado: "sin_reaccion", plan: null };
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
            const resultados = [];
            for (const objetivo of lista)
                resultados.push(await procesarObjetivo(evento, objetivo));
            return resultados;
        },
        async reintentarFallido(clave) {
            const fallido = (await almacen.fallidos()).find((f) => f.clave === clave);
            if (!fallido)
                throw new Error(`No hay un fallido con la clave «${clave}».`);
            if (!fallido.plan)
                throw new ErrorDefinitivo(`El fallido «${clave}» no llegó a tener plan (${fallido.motivo}): hay que volver a entregar el evento.`);
            await almacen.quitarFallido(clave);
            return ejecutarPlan(clave, fallido.plan, fallido.evento, fallido.instancia);
        },
    };
}
const claveFin = (clave) => huella({ clave, paso: "fin" });
const mensajeDe = (error) => (error instanceof Error ? error.message : String(error));
const idDeFlujo = (flujo) => (Array.isArray(flujo) ? flujo[0]?.id ?? "" : flujo.id);
/** Almacén en memoria, para tests y para probar. No sobrevive a un reinicio: en producción usá uno durable. */
export function crearAlmacenMemoria() {
    const planes = new Map();
    const pasos = new Set();
    const cola = new Map();
    return {
        leerPlan: async (clave) => planes.get(clave) ?? null,
        fijarPlan: async (clave, plan) => {
            if (!planes.has(clave))
                planes.set(clave, plan);
            return planes.get(clave);
        },
        pasoHecho: async (clave) => pasos.has(clave),
        marcarPaso: async (clave) => void pasos.add(clave),
        agregarFallido: async (f) => void cola.set(f.clave, f),
        fallidos: async () => [...cola.values()],
        quitarFallido: async (clave) => void cola.delete(clave),
    };
}
//# sourceMappingURL=ejecutor.js.map