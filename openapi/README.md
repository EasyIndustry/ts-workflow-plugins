# openapi

Convierte las operaciones de una API descrita con **OpenAPI 3** en efectos de `ts-workflow-core`. Así un flujo **escribe a
través de la API del sistema**, con sus permisos, sus validaciones y su historial, y no directo en la base.

**Estado: `drafts`.** Permisos: `red`.

## Por qué por la API

Escribir directo en una tabla saltea todo lo que el sistema hace alrededor de ese dato: quién puede, qué se valida, qué más
se actualiza, qué queda registrado. La API ya lo resuelve. Y como la especificación lista todas las operaciones con el
schema de lo que reciben, el plugin las ofrece sin que nadie escriba un adaptador.

## Uso

```ts
import { crearPluginOpenApi, operacionesDe } from "ts-workflow-plugins/openapi";

// Para elegir qué exponer: todas las operaciones de la especificación, con su id.
operacionesDe(especificacion).map((o) => `${o.id}  ${o.metodo.toUpperCase()} ${o.ruta}`);

const plugin = crearPluginOpenApi({
  especificacion,                                  // el documento OpenAPI 3, ya leído
  urlBase: "https://api.ejemplo.test",
  permitidas: ["post-pedidos", { id: "post-pedidos-id-cerrar", nombre: "Cerrar un pedido" }],
  credencial: () => `Bearer ${tokenDeServicio}`,   // la identidad del flujo ante la API
});
const registro = crearRegistro([proveedorDeLaApp, plugin.proveedor]);
```

En una definición, el efecto recibe los valores separados por dónde van:

```json
{ "efecto": "openapi.post-pedidos-id-cerrar", "params": { "ruta": { "id": 42 }, "consulta": { "avisar": true }, "cuerpo": { "motivo": "entregado" } } }
```

## Cómo lee la especificación

- **Una operación por método y ruta.** Su id es el `operationId`; si no tiene, se arma con el método y la ruta
  (`POST /pedidos/{id}/cerrar` → `post-pedidos-id-cerrar`), así queda estable mientras la ruta no cambie.
- **El nombre** es el `summary`. Muchas especificaciones no lo traen: por eso al permitir una operación se le puede dar el
  nombre y la descripción con los que la va a ver una persona.
- **El schema de entrada** tiene `ruta`, `consulta` y `cuerpo` (solo `application/json`), cada uno si la operación lo usa. Las
  referencias (`$ref`) se resuelven; una que se nombra a sí misma se corta.
- Solo OpenAPI 3. Swagger 2 se rechaza con un mensaje claro.

## La identidad del flujo

La API tiene que saber quién hace el cambio, también cuando el flujo lo disparó algo que no es una persona. Para eso:

- **`credencial`** es la de un usuario de servicio del sistema, creado para los flujos. Lo que ese usuario puede hacer es el
  tope de lo que puede hacer cualquier flujo, y es quien queda en el historial del sistema.
- Cada pedido lleva además **de qué flujo viene**: `x-flujo`, `x-flujo-instancia` y `x-flujo-evento`. El sistema los puede
  guardar junto al cambio.
- **`idempotency-key`** lleva la misma clave en cada reintento, para que la API no haga dos veces lo mismo.

## Cuando falla

| Qué pasó | Qué hace |
|---|---|
| 2xx | Bien. |
| Sin conexión, sin respuesta a tiempo, 5xx, 408, 429 | Error común: el ejecutor **reintenta**. |
| Otro 4xx (400, 401, 403, 404, 409, 422…) o una redirección | `ErrorDefinitivo`: **no se reintenta**. |
| Falta un valor de la ruta | `ErrorDefinitivo`, sin hacer el pedido. |

El cuerpo de la respuesta no va al mensaje del error: puede traer datos que no tienen que quedar en un registro.

## Seguridad

- **Nada se expone solo.** `permitidas` arranca vacía.
- **Los pedidos van solo a `urlBase`.** La ruta sale de la especificación; de una definición entran únicamente valores, escapados.
- **No sigue redirecciones**, para no llevar la credencial a otro lado.
- **Sin secretos:** la credencial la inyecta la app y no se guarda ni se registra.

## Límites de esta versión

- Un efecto no devuelve datos, así que una operación de lectura (`GET`) se puede llamar pero su respuesta no se usa.
- Una sola API por registro (el id del plugin es fijo).
- No compara dos versiones de una especificación: si la API cambia o quita una operación que un flujo usa, hoy se nota al
  crear el plugin (si la quitaron) o al ejecutar.
