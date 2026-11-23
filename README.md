# ts-workflow-plugins

Plugins genéricos para [`ts-workflow-core`](https://github.com/EasyIndustry/ts-workflow-core), el motor de flujos puro.
El core decide qué hacer; acá está lo que escucha el mundo y ejecuta: el contrato de plugin, un ejecutor común de
reacciones y un paquete por carpeta.

## Estructura

```
plugins/<nombre>.json      ficha: versión, permisos, compatible_core, procedencia
<nombre>/src, test, README el código de cada plugin
nucleo/                    contrato (definirPlugin) y ejecutor común
schema/plugin.schema.json  formato de la ficha
dist/                      compilado y versionado (se instala desde git)
```

Ramas: **`cured`** (por defecto, lo revisado) y **`drafts`** (lo que se está probando). Se promueve por plugin, con un PR por carpeta.

## Instalar

Siempre fijando un tag o un commit. **No se publica en npm.**

```bash
npm i "github:EasyIndustry/ts-workflow-plugins#<tag-o-commit>" "github:EasyIndustry/ts-workflow-core#<tag>"
```

```ts
import { crearEjecutor, definirPlugin } from "ts-workflow-plugins/nucleo";
```

## El contrato

```ts
const plugin = definirPlugin({
  id: "mi-plugin",
  version: "0.1.0",
  permisos: ["red"],
  eventos: [{ id: "mi-plugin.llego", nombre: "Llegó algo", tipo: "evento", schemaEntrada: { /* … */ } }],
  condiciones: [/* capacidades de tipo condicion */],
  efectos: [{ id: "mi-plugin.avisar", nombre: "Avisar", tipo: "efecto", ejecutar: async ({ clave, params }) => { /* … */ } }],
  sincronizar: async (suscripciones) => ({ creados: [], borrados: [], conservados: [] }),
  escuchar: async (cb) => async () => { /* detener */ },
});

const registro = crearRegistro([proveedorDeLaApp, plugin.proveedor]);
```

- `sincronizar(suscripciones)` deja el sistema escuchando exactamente eso, y es idempotente. Las suscripciones salen de
  `suscripcionesNecesarias(versiones, versionesActivas)`, que conserva lo que usan las versiones viejas con instancias activas.
- `escuchar(cb)` entrega eventos con un `id` estable. Si `cb` falla, el evento se vuelve a entregar.

## El ejecutor común

```ts
const ejecutor = crearEjecutor({ registro, almacen, objetivos, aplicarTransicion, efectos: efectosDe([plugin]) });
const detener = await plugin.escuchar!(async (evento) => void (await ejecutor.procesar(evento)));
```

| Qué | Cómo |
|---|---|
| Reintentos | Por paso, con espera creciente (`maxIntentos`, `esperaMs`). `ErrorDefinitivo` no se reintenta. |
| Idempotencia | El plan se fija la primera vez y cada paso confirmado no se repite. Es **al menos una vez**: cada paso recibe una `clave` estable para no duplicar trabajo si se cae entre hacerlo y confirmarlo. |
| Bucles | Cada evento lleva su cadena de causas; al pasar `topeCadena` saltos se corta y va a fallidos. |
| Fallidos | Lo que no se pudo queda en la cola con su motivo. `reintentarFallido(clave)` retoma desde el paso donde quedó. |

`crearAlmacenMemoria()` sirve para probar. En producción, el almacén tiene que ser durable.

## Plugins

Ver [`plugins/`](plugins/). Proponer uno: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licencia

[MIT](LICENSE).
