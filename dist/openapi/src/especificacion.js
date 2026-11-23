/**
 * Leer una especificación OpenAPI 3 y sacar de ella las operaciones, cada una con el schema de lo que recibe. Puro: no
 * hace pedidos ni sabe de quién es la API.
 */
export const ID_PLUGIN = "openapi";
export const METODOS = ["get", "post", "put", "patch", "delete"];
export class ErrorEspecificacion extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = "ErrorEspecificacion";
    }
}
const esObjeto = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const texto = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** El id de una operación sin `operationId`: «post-pedidos-id-cerrar» para `POST /pedidos/{id}/cerrar`. */
export function idDeOperacion(metodo, ruta) {
    return `${metodo}-${ruta}`
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}
function seguir(raiz, ref) {
    if (!ref.startsWith("#/"))
        return undefined;
    let actual = raiz;
    for (const parte of ref.slice(2).split("/")) {
        if (!esObjeto(actual))
            return undefined;
        actual = actual[parte.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return actual;
}
/**
 * Reemplaza cada `$ref` por lo que nombra, porque quien valida y quien arma el formulario no los siguen. Un `$ref` que se
 * nombra a sí mismo (un árbol, por ejemplo) o que apunta afuera del documento queda como «cualquier cosa».
 */
function resolver(raiz, valor, abiertos) {
    if (Array.isArray(valor))
        return valor.map((v) => resolver(raiz, v, abiertos));
    if (!esObjeto(valor))
        return valor;
    const ref = valor["$ref"];
    if (typeof ref === "string") {
        if (abiertos.has(ref))
            return {};
        const destino = seguir(raiz, ref);
        return destino === undefined ? {} : resolver(raiz, destino, new Set([...abiertos, ref]));
    }
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, resolver(raiz, v, abiertos)]));
}
/** Todas las operaciones de la especificación, en el orden en que están. Falla si no es OpenAPI 3 o si dos quedan con el mismo id. */
export function operacionesDe(especificacion) {
    if (!esObjeto(especificacion))
        throw new ErrorEspecificacion("La especificación no es un objeto.");
    const version = especificacion["openapi"];
    if (typeof version !== "string" || !version.startsWith("3.")) {
        throw new ErrorEspecificacion(`Solo se lee OpenAPI 3. Esta dice «${String(version ?? especificacion["swagger"] ?? "sin versión")}».`);
    }
    const rutas = especificacion["paths"];
    if (!esObjeto(rutas))
        throw new ErrorEspecificacion("La especificación no tiene rutas (paths).");
    const operaciones = [];
    const vistos = new Map();
    for (const [ruta, item] of Object.entries(rutas)) {
        if (!esObjeto(item))
            continue;
        const comunes = Array.isArray(item["parameters"]) ? item["parameters"] : [];
        for (const metodo of METODOS) {
            const op = item[metodo];
            if (!esObjeto(op))
                continue;
            const id = (texto(op["operationId"]) ?? idDeOperacion(metodo, ruta)).replace(/[^A-Za-z0-9_-]+/g, "-");
            const donde = `${metodo.toUpperCase()} ${ruta}`;
            const otra = vistos.get(id);
            if (otra)
                throw new ErrorEspecificacion(`Dos operaciones quedan con el id «${id}»: ${otra} y ${donde}.`);
            vistos.set(id, donde);
            // Los parámetros de la operación pisan a los de la ruta con el mismo nombre y lugar.
            const parametros = new Map();
            for (const crudo of [...comunes, ...(Array.isArray(op["parameters"]) ? op["parameters"] : [])]) {
                const p = resolver(especificacion, crudo, new Set());
                if (esObjeto(p) && typeof p["name"] === "string" && typeof p["in"] === "string")
                    parametros.set(`${p["in"]}:${p["name"]}`, p);
            }
            const de = (lugar) => [...parametros.values()].filter((p) => p["in"] === lugar);
            const propiedades = (lista) => Object.fromEntries(lista.map((p) => [p["name"], esObjeto(p["schema"]) ? p["schema"] : {}]));
            const deRuta = de("path");
            const deConsulta = de("query");
            const obligatoriosDeConsulta = deConsulta.filter((p) => p["required"] === true).map((p) => p["name"]);
            const cuerpo = resolver(especificacion, op["requestBody"], new Set());
            const contenido = esObjeto(cuerpo) && esObjeto(cuerpo["content"]) ? cuerpo["content"]["application/json"] : undefined;
            const tieneCuerpo = esObjeto(contenido);
            const partes = {};
            const obligatorias = [];
            if (deRuta.length) {
                partes["ruta"] = { type: "object", properties: propiedades(deRuta), required: deRuta.map((p) => p["name"]), additionalProperties: false };
                obligatorias.push("ruta");
            }
            if (deConsulta.length) {
                partes["consulta"] = { type: "object", properties: propiedades(deConsulta), required: obligatoriosDeConsulta, additionalProperties: false };
                if (obligatoriosDeConsulta.length)
                    obligatorias.push("consulta");
            }
            if (tieneCuerpo) {
                partes["cuerpo"] = esObjeto(contenido["schema"]) ? contenido["schema"] : {};
                if (esObjeto(cuerpo) && cuerpo["required"] === true)
                    obligatorias.push("cuerpo");
            }
            operaciones.push({
                id,
                capacidad: `${ID_PLUGIN}.${id}`,
                metodo,
                ruta,
                nombre: texto(op["summary"]) ?? texto(op["operationId"]) ?? donde,
                descripcion: texto(op["description"]),
                grupo: Array.isArray(op["tags"]) ? texto(op["tags"][0]) : undefined,
                parametrosDeRuta: deRuta.map((p) => p["name"]),
                parametrosDeConsulta: deConsulta.map((p) => p["name"]),
                tieneCuerpo,
                schemaEntrada: { type: "object", properties: partes, required: obligatorias, additionalProperties: false },
            });
        }
    }
    return operaciones;
}
//# sourceMappingURL=especificacion.js.map