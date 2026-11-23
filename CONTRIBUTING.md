# Contribuir

Primero, [`POLITICA.md`](POLITICA.md): qué entra y qué no.

## Proponer un plugin

1. Abrí un PR contra **`drafts`** con:
   - `plugins/<nombre>.json`, válido contra [`schema/plugin.schema.json`](schema/plugin.schema.json);
   - `<nombre>/src/index.ts`, que exporte `ficha` y el plugin hecho con `definirPlugin`;
   - `<nombre>/test/` y `<nombre>/README.md`;
   - `dist/` regenerado (`npm run build`).
2. El `name`, la carpeta y el id del plugin son el mismo; la `version` y los `permisos` de la ficha coinciden con los del código.
3. Las capacidades empiezan con `<nombre>.` (por ejemplo, `mi-plugin.algo-paso`).

## Antes del PR

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run fichas
npm run build
```

Los tests que necesitan un servicio (como Postgres) se saltean si falta su variable de entorno y corren en el CI.

## Qué corre el CI

- **Fichas:** valida `plugins/*.json` como datos, con el script y el schema **de la rama base**. No importa ni ejecuta el código del PR.
- **Tests:** tipos, tests de cada plugin (con los servicios que necesiten) y que `dist/` coincida con el build.
- **Un PR desde un fork no corre los tests** ni instala sus dependencias: solo la validación de fichas. Quien mantiene el
  repo lee el código y, si está bien, lo trae a una rama propia, y ahí corre el CI completo.
- No se usa `pull_request_target`, el token es de solo lectura y no hay secretos en el CI.

## Promover a `cured`

Un PR por carpeta, que trae solo `<nombre>/`, `plugins/<nombre>.json` y su parte de `dist/`. Lo decide quien mantiene el repo.
