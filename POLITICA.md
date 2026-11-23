# Política del repositorio

Plugins **genéricos** para [`ts-workflow-core`](https://github.com/EasyIndustry/ts-workflow-core), MIT. Vale la política
del core: quién pide no cambia la respuesta, y un pedido se lee por la necesidad, no por la solución que trae.

## Qué entra

**La pregunta:** ¿le sirve a cualquier app con entidades que tienen un ciclo de vida configurable?

- **Entra:** integraciones con tecnologías (una base de datos, una cola, un servicio de mensajería genérico) que sirvan
  al menos a dos dominios distintos.
- **No entra:** lo atado a un cliente, un negocio o un sistema interno. **Solo genéricos; lo del cliente queda privado**,
  en su app o en un plugin propio. Tampoco nombres propios de clientes, marcas o personas: ni en código, tests, ejemplos
  ni issues.
- **Un cliente es una configuración:** sus tablas, reglas y credenciales las pasa la app al crear el plugin.

## Reglas de un plugin

1. **Declara lo que necesita.** La ficha lista sus `permisos` (`db:ddl`, `red`, …). Es la superficie de acceso que le da quien lo instala.
2. **Sin SQL ni código armado por el usuario.** Lo que venga de una definición es un dato validado contra una lista permitida.
3. **Sin secretos.** Las credenciales las inyecta la app; ni en el repo, ni en los tests, ni en los logs.
4. **Pocas dependencias.** Mejor recibir el cliente ya creado (`pg`, por ejemplo) que depender de él.
5. **Con tests propios**, que corren en el CI.
6. **Idempotente.** `sincronizar` se puede correr dos veces, y un evento se puede entregar dos veces.

## Ramas y promoción

- **`drafts`:** donde entra un plugin y se prueba. Puede cambiar sin aviso.
- **`cured`** (por defecto): lo revisado.
- **Se promueve por plugin, con un PR por carpeta** de `drafts` a `cured`. No se promueve `drafts` entero. Decide quien
  mantiene el repo, después de leer el código y ver el CI en verde.

## Instalar

Se instala **fijando un tag o un commit**, nunca una rama. **No se publica en npm.** La copia no se edita: un cambio vuelve acá como issue.

## Seguridad del CI

El CI nunca ejecuta código de terceros sin revisar. Ver [`CONTRIBUTING.md`](CONTRIBUTING.md#qué-corre-el-ci).
