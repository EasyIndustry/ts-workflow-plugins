import { ErrorPlugin } from "../../nucleo/src/index.js";
export const ID_PLUGIN = "postgres-triggers";
export const EVENTOS = {
    INSERT: `${ID_PLUGIN}.fila-insertada`,
    UPDATE: `${ID_PLUGIN}.fila-actualizada`,
    DELETE: `${ID_PLUGIN}.fila-borrada`,
};
const IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/;
export const esIdentificador = (valor) => typeof valor === "string" && IDENTIFICADOR.test(valor);
/** Parte «esquema.tabla». Falla con cualquier cosa que no sean dos identificadores simples. */
export function partirTabla(nombre) {
    if (typeof nombre !== "string")
        throw new ErrorPlugin(`${ID_PLUGIN}: tabla inválida.`);
    const partes = nombre.split(".");
    if (partes.length !== 2 || !partes.every(esIdentificador))
        throw new ErrorPlugin(`${ID_PLUGIN}: la tabla «${nombre}» tiene que ser esquema.tabla, en minúsculas.`);
    return { esquema: partes[0], tabla: partes[1] };
}
export function validarPermitidas(permitidas) {
    const tablas = Object.keys(permitidas);
    if (!tablas.length)
        throw new ErrorPlugin(`${ID_PLUGIN}: la lista permitida está vacía.`);
    for (const nombre of tablas) {
        partirTabla(nombre);
        const campos = permitidas[nombre];
        if (!Array.isArray(campos) || !campos.length)
            throw new ErrorPlugin(`${ID_PLUGIN}: «${nombre}» necesita al menos un campo permitido.`);
        for (const c of campos)
            if (!esIdentificador(c))
                throw new ErrorPlugin(`${ID_PLUGIN}: campo inválido en «${nombre}»: «${String(c)}».`);
    }
}
const operacionDe = (evento) => Object.keys(EVENTOS).find((o) => EVENTOS[o] === evento);
/**
 * Convierte las suscripciones de este plugin en lo que recibe `flujo.reconciliar`, validando contra la lista permitida.
 * Las de otros plugins se ignoran. La base vuelve a validar todo por su cuenta.
 */
export function deseadasDe(suscripciones, permitidas) {
    const deseadas = [];
    for (const s of suscripciones) {
        const operacion = operacionDe(s.evento);
        if (!operacion)
            continue;
        const { tabla: nombre, campos, ...resto } = s.params;
        if (Object.keys(resto).length)
            throw new ErrorPlugin(`${ID_PLUGIN}: parámetros desconocidos: ${Object.keys(resto).join(", ")}.`);
        const { esquema, tabla } = partirTabla(nombre);
        const clavePermitida = `${esquema}.${tabla}`;
        const admitidos = Object.hasOwn(permitidas, clavePermitida) ? permitidas[clavePermitida] : undefined;
        if (!admitidos)
            throw new ErrorPlugin(`${ID_PLUGIN}: la tabla «${clavePermitida}» no está en la lista permitida.`);
        let lista = null;
        if (campos !== undefined) {
            if (operacion !== "UPDATE")
                throw new ErrorPlugin(`${ID_PLUGIN}: «campos» solo aplica a ${EVENTOS.UPDATE}.`);
            if (!Array.isArray(campos) || !campos.length)
                throw new ErrorPlugin(`${ID_PLUGIN}: «campos» tiene que ser una lista con algún campo.`);
            for (const c of campos) {
                if (!esIdentificador(c) || !admitidos.includes(c))
                    throw new ErrorPlugin(`${ID_PLUGIN}: el campo «${String(c)}» de «${clavePermitida}» no está permitido.`);
            }
            lista = [...new Set(campos)].sort();
        }
        deseadas.push({ clave: s.clave, evento: s.evento, esquema, tabla, operacion, campos: lista, params: s.params });
    }
    return deseadas;
}
/** El `schemaEntrada` de los eventos: un editor o `validarDefinicion` rechazan una tabla no permitida antes de llegar a la base. */
export function esquemaDeEvento(permitidas, conCampos) {
    const todos = [...new Set(Object.values(permitidas).flat())].sort();
    return {
        type: "object",
        properties: {
            tabla: { type: "string", enum: Object.keys(permitidas).sort() },
            ...(conCampos ? { campos: { type: "array", minItems: 1, items: { type: "string", enum: todos } } } : {}),
        },
        required: ["tabla"],
        additionalProperties: false,
    };
}
export function leerCadena(texto) {
    const m = texto === null ? null : /^([A-Za-z0-9:_.-]{1,200})\|([0-9]{1,4})$/.exec(texto);
    return m ? { raiz: m[1], profundidad: Number(m[2]) } : undefined;
}
/** Un evento por cada suscripción que coincide con la fila. El id es estable: una reentrega no se ejecuta dos veces. */
export function eventosDeFila(fila, suscripciones) {
    return suscripciones
        .filter((s) => s.esquema === fila.esquema && s.tabla === fila.tabla && s.operacion === fila.operacion)
        .filter((s) => fila.operacion !== "UPDATE" || s.campos === null || s.campos.some((c) => fila.cambiados.includes(c)))
        .map((s) => ({
        id: `outbox:${fila.id}:${s.clave.slice(0, 16)}`,
        evento: s.evento,
        params: s.params,
        datos: { tabla: `${fila.esquema}.${fila.tabla}`, operacion: fila.operacion, pk: fila.pk, antes: fila.antes, despues: fila.despues, cambiados: fila.cambiados },
        cadena: leerCadena(fila.cadena),
    }));
}
//# sourceMappingURL=suscripciones.js.map