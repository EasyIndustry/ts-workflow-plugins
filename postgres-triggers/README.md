# postgres-triggers

Convierte cambios en filas de Postgres en eventos de `ts-workflow-core`, sin perder ninguno y sin darle DDL a la API.

**Estado: `drafts`.** Permisos: `db:lectura`, `db:escritura`, `db:ddl` (este último, solo a través de una función controlada).

## Cómo funciona

1. Un trigger `flujo_*` escribe en `flujo.outbox` **dentro de la misma transacción** que el cambio: si se revierte, no hay evento.
2. `NOTIFY` solo despierta al que escucha. La fuente de verdad es el outbox, y un sondeo cubre los avisos perdidos.
3. Los triggers se crean a demanda desde las suscripciones: uno por tabla y operación, con una única función genérica.
4. La entrega es **al menos una vez**, con un id estable por evento: el ejecutor común evita repetir el trabajo.

## Instalación (una vez, en una migración, con un rol administrador)

```ts
import { instalar, autorizar } from "ts-workflow-plugins/postgres-triggers";

await instalar(admin);
await autorizar(admin, { "public.pagos": ["estado", "monto"] }, "rol_api");
```

Las tablas permitidas tienen que tener clave primaria y un dueño que **no** sea superusuario.

## Uso (con el rol de la API)

```ts
const plugin = crearPluginPostgresTriggers({ cliente: pool, conexionEscucha: clienteDedicado, permitidas: { "public.pagos": ["estado", "monto"] } });
const registro = crearRegistro([proveedorDeLaApp, plugin.proveedor]);

await plugin.sincronizar!(suscripcionesNecesarias(versiones, versionesActivas));

const ejecutor = crearEjecutor({ registro, almacen: crearAlmacenPostgres(pool), objetivos, aplicarTransicion, efectos });
const detener = await plugin.escuchar!(async (e) => void (await ejecutor.procesar(e)));
```

En una definición:

```json
{ "id": "al-acreditar", "evento": "postgres-triggers.fila-actualizada", "params": { "tabla": "public.pagos", "campos": ["estado"] }, "desde": ["esperando"], "transicion": "confirmar" }
```

Eventos: `fila-insertada`, `fila-actualizada` (con `campos` opcional) y `fila-borrada`. Los datos de la fila llegan en `evento.datos`: clave primaria, valores antes y después (**solo de los campos permitidos**) y qué cambió.

## Seguridad

- **Sin SQL del usuario.** Las definiciones solo aportan datos, que se validan contra la lista permitida en TypeScript y otra vez **dentro de la base**. Los identificadores se citan con `format('%I')`.
- **Sin DDL en la API.** Su rol solo puede ejecutar `flujo.reconciliar`, que corre como `flujo_ddl` (sin login) y únicamente toca lo que un administrador permitió.
- **`flujo_ddl` hereda el rol dueño de las tablas permitidas**, porque Postgres exige ser dueño para borrar un trigger. Por eso conviene que ese dueño no tenga más tablas sensibles de las necesarias, y nunca puede ser superusuario.
- **Reconciliación segura:** todo o nada, con `lock_timeout` de 3 s, sin tocar triggers ajenos y sin vaciar por accidente (hay que pedirlo con `permitirVaciar`).
- **Versiones:** `suscripcionesNecesarias` conserva lo que usan las versiones viejas con instancias activas.

## Bucles

Si un efecto escribe en una tabla escuchada, envolvé la escritura en `conCadena(conexion, cadena, ...)` con la `cadena` que recibe: el evento siguiente la hereda y el ejecutor corta al llegar al tope.

## Tests

Los unitarios corren siempre. Los de base necesitan `PRUEBAS_POSTGRES_URL` y corren en el CI, contra Postgres 14 y 17.
