/**
 * El contrato de un plugin. Un plugin aporta capacidades al registro del core y, si trae eventos, sabe escucharlos.
 * No decide nada: las decisiones son de `reaccionar` (core) y la ejecución del ejecutor común.
 */
export const PERMISOS = ["db:lectura", "db:escritura", "db:ddl", "red", "archivos", "procesos"];
export class ErrorPlugin extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = "ErrorPlugin";
    }
}
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
/** Valida la declaración y la congela. Falla al arrancar, no cuando llega el primer evento. */
export function definirPlugin(definicion) {
    const { id, version, permisos } = definicion;
    if (typeof id !== "string" || !ID.test(id))
        throw new ErrorPlugin(`Id de plugin inválido: «${String(id)}». Usá minúsculas, números y guiones.`);
    if (typeof version !== "string" || !SEMVER.test(version))
        throw new ErrorPlugin(`${id}: la versión «${String(version)}» no es semver.`);
    if (!Array.isArray(permisos))
        throw new ErrorPlugin(`${id}: faltan los permisos (una lista, aunque sea vacía).`);
    for (const p of permisos)
        if (!PERMISOS.includes(p))
            throw new ErrorPlugin(`${id}: permiso desconocido «${String(p)}».`);
    const eventos = definicion.eventos ?? [];
    const condiciones = definicion.condiciones ?? [];
    const efectos = definicion.efectos ?? [];
    const vistos = new Set();
    const revisar = (c, tipo) => {
        if (c.tipo !== tipo)
            throw new ErrorPlugin(`${id}: «${c.id}» está declarada como ${tipo} pero es de tipo ${c.tipo}.`);
        if (!c.id.startsWith(`${id}.`))
            throw new ErrorPlugin(`${id}: la capacidad «${c.id}» tiene que empezar con «${id}.».`);
        if (vistos.has(c.id))
            throw new ErrorPlugin(`${id}: la capacidad «${c.id}» está dos veces.`);
        vistos.add(c.id);
    };
    eventos.forEach((c) => revisar(c, "evento"));
    condiciones.forEach((c) => revisar(c, "condicion"));
    efectos.forEach((c) => {
        revisar(c, "efecto");
        if (typeof c.ejecutar !== "function")
            throw new ErrorPlugin(`${id}: el efecto «${c.id}» no tiene la función ejecutar.`);
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
    });
}
/** Junta los efectos de varios plugins en el mapa que recibe el ejecutor. */
export function efectosDe(plugins) {
    return Object.fromEntries(plugins.flatMap((p) => p.efectos.map((e) => [e.id, e.ejecutar])));
}
//# sourceMappingURL=contrato.js.map