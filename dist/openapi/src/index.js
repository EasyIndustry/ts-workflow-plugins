import { definirPlugin, ErrorDefinitivo, ErrorPlugin } from "../../nucleo/src/index.js";
import { ID_PLUGIN, operacionesDe } from "./especificacion.js";
export { ErrorEspecificacion, idDeOperacion, METODOS, operacionesDe } from "./especificacion.js";
export const ficha = { id: ID_PLUGIN, version: "0.1.0", permisos: ["red"] };
const objeto = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
/** Los encabezados solo llevan ASCII: lo demás se escapa. */
const paraEncabezado = (v) => encodeURIComponent(v);
/**
 * Hace el pedido de una operación. Un 2xx es bien. Lo que puede andar si se prueba de nuevo (sin conexión, sin respuesta a
 * tiempo, 5xx, 408 y 429) falla con un error común, que el ejecutor reintenta. El resto (4xx, una redirección) no se
 * arregla reintentando: falla con `ErrorDefinitivo`.
 */
async function llamar(operacion, entrada, opciones, base) {
    const params = objeto(entrada.params);
    const deRuta = objeto(params["ruta"]);
    const deConsulta = objeto(params["consulta"]);
    const donde = `${operacion.metodo.toUpperCase()} ${operacion.ruta}`;
    // La ruta sale de la especificación. De la definición solo entran los valores, escapados.
    const camino = operacion.ruta.replace(/\{([^}]+)\}/g, (_, nombre) => {
        const valor = deRuta[nombre];
        if (valor === undefined || valor === null || valor === "")
            throw new ErrorDefinitivo(`${donde}: falta «${nombre}» en la ruta.`);
        return encodeURIComponent(String(valor));
    });
    const url = new URL(base + camino);
    for (const nombre of operacion.parametrosDeConsulta) {
        const valor = deConsulta[nombre];
        for (const v of Array.isArray(valor) ? valor : [valor])
            if (v !== undefined && v !== null)
                url.searchParams.append(nombre, String(v));
    }
    const encabezados = {
        accept: "application/json",
        // La misma clave en cada reintento: la API puede usarla para no hacer dos veces lo mismo.
        "idempotency-key": paraEncabezado(entrada.clave),
        "x-flujo": paraEncabezado(entrada.flujo),
        "x-flujo-instancia": paraEncabezado(entrada.instancia),
        "x-flujo-evento": paraEncabezado(entrada.evento.id),
    };
    if (opciones.credencial)
        encabezados["authorization"] = await opciones.credencial();
    const conCuerpo = operacion.tieneCuerpo && params["cuerpo"] !== undefined;
    if (conCuerpo)
        encabezados["content-type"] = "application/json";
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), opciones.tiempoMs ?? 15000);
    let respuesta;
    try {
        respuesta = await (opciones.fetch ?? fetch)(url, {
            method: operacion.metodo.toUpperCase(),
            headers: encabezados,
            ...(conCuerpo && { body: JSON.stringify(params["cuerpo"]) }),
            // Una redirección no se sigue: podría llevar la credencial a otro lado.
            redirect: "manual",
            signal: corte.signal,
        });
    }
    catch (causa) {
        throw new Error(`${donde}: ${corte.signal.aborted ? "no respondió a tiempo" : "no se pudo conectar"}.`, { cause: causa });
    }
    finally {
        clearTimeout(reloj);
    }
    const estado = respuesta.status;
    if (estado >= 200 && estado < 300)
        return;
    // El cuerpo de la respuesta no va al mensaje: puede traer datos que no tienen que quedar en un registro.
    const mensaje = `${donde} respondió ${estado}.`;
    if (estado >= 500 || estado === 408 || estado === 429)
        throw new Error(mensaje);
    throw new ErrorDefinitivo(mensaje);
}
/**
 * Convierte operaciones de una API descrita con OpenAPI 3 en efectos del registro. Así un flujo escribe a través de la
 * API del sistema, con sus permisos y sus reglas, y no directo en la base.
 */
export function crearPluginOpenApi(opciones) {
    let direccion;
    try {
        direccion = new URL(opciones.urlBase);
    }
    catch {
        throw new ErrorPlugin(`${ID_PLUGIN}: la dirección de la API no es válida.`);
    }
    if (direccion.protocol !== "https:" && direccion.protocol !== "http:")
        throw new ErrorPlugin(`${ID_PLUGIN}: la dirección de la API tiene que ser http o https.`);
    const base = direccion.href.replace(/\/+$/, "");
    const todas = new Map(operacionesDe(opciones.especificacion).map((o) => [o.id, o]));
    const elegidas = new Map((opciones.permitidas ?? []).map((p) => (typeof p === "string" ? [p, { id: p }] : [p.id, p])));
    const efectos = [...elegidas.values()].map((elegida) => {
        const operacion = todas.get(elegida.id);
        if (!operacion)
            throw new ErrorPlugin(`${ID_PLUGIN}: la operación permitida «${elegida.id}» no está en la especificación.`);
        return {
            id: operacion.capacidad,
            nombre: elegida.nombre ?? operacion.nombre,
            tipo: "efecto",
            descripcion: elegida.descripcion ?? operacion.descripcion,
            grupo: operacion.grupo,
            schemaEntrada: operacion.schemaEntrada,
            ejecutar: (entrada) => llamar(operacion, entrada, opciones, base),
        };
    });
    return definirPlugin({ id: ficha.id, version: ficha.version, permisos: ficha.permisos, efectos });
}
//# sourceMappingURL=index.js.map