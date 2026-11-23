#!/usr/bin/env node
// Valida plugins/*.json como DATOS: nunca importa ni ejecuta el código del plugin.
// Uso: node scripts/validar-fichas.mjs <raíz a validar> <schema>
// En un PR, este script y el schema salen de la rama base y <raíz> es el checkout del PR.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import Ajv from "ajv";

const [raiz, rutaSchema] = process.argv.slice(2);
if (!raiz || !rutaSchema) {
  console.error("Uso: validar-fichas.mjs <raíz> <schema>");
  process.exit(2);
}
const validar = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(rutaSchema, "utf8")));
const carpeta = join(raiz, "plugins");
const archivos = existsSync(carpeta) ? readdirSync(carpeta).filter((a) => a.endsWith(".json")) : [];
const errores = [];

for (const archivo of archivos) {
  const ruta = `plugins/${archivo}`;
  let ficha;
  try {
    ficha = JSON.parse(readFileSync(join(carpeta, archivo), "utf8"));
  } catch (e) {
    errores.push(`${ruta}: JSON inválido (${e.message})`);
    continue;
  }
  if (!validar(ficha)) {
    for (const e of validar.errors) errores.push(`${ruta}: ${e.instancePath || "<raíz>"} ${e.message}`);
    continue;
  }
  const nombre = basename(archivo, ".json");
  if (ficha.name !== nombre) errores.push(`${ruta}: "name" (${ficha.name}) tiene que coincidir con el archivo (${nombre})`);
  if (ficha.path !== nombre) errores.push(`${ruta}: "path" (${ficha.path}) tiene que ser la carpeta ${nombre}`);
  for (const requerido of ["src/index.ts", "test", "README.md"]) {
    if (!existsSync(join(raiz, ficha.path, requerido))) errores.push(`${ruta}: falta ${ficha.path}/${requerido}`);
  }
}

for (const e of errores) console.error(`::error::${e}`);
if (errores.length) process.exit(1);
console.log(`${archivos.length} ficha(s) válida(s).`);
