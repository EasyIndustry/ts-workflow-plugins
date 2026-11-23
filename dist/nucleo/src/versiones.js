import { suscripciones, ultimaVersion } from "ts-workflow-core";
/**
 * Las suscripciones que hay que mantener: las de la última versión de cada flujo y las de toda versión vieja que todavía
 * tenga instancias activas. `versionesActivas` es, por id de flujo, las versiones con instancias sin terminar.
 */
export function suscripcionesNecesarias(versiones, versionesActivas) {
    const porFlujo = new Map();
    for (const d of versiones)
        porFlujo.set(d.id, [...(porFlujo.get(d.id) ?? []), d]);
    const enUso = [];
    for (const [id, lista] of porFlujo) {
        const ultima = ultimaVersion(lista).version;
        const activas = new Set(Object.hasOwn(versionesActivas, id) ? versionesActivas[id] : []);
        enUso.push(...lista.filter((d) => d.version === ultima || activas.has(d.version)));
    }
    return suscripciones(enUso);
}
//# sourceMappingURL=versiones.js.map