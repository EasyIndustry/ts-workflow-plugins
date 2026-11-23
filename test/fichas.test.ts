import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fichas = readdirSync(join(RAIZ, "plugins"))
  .filter((a) => a.endsWith(".json"))
  .map((a) => JSON.parse(readFileSync(join(RAIZ, "plugins", a), "utf8")) as { name: string; version: string; permisos: string[]; path: string });

describe("fichas contra el código", () => {
  it("el paquete no se puede publicar en npm por accidente", () => {
    expect((JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { private?: boolean }).private).toBe(true);
  });

  it.skipIf(!fichas.length).each(fichas.map((f) => [f.name, f] as const))("%s declara lo mismo en la ficha y en el código", async (_n, f) => {
    const entrada = join(RAIZ, f.path, "src", "index.ts");
    expect(existsSync(entrada)).toBe(true);
    const { ficha } = (await import(pathToFileURL(entrada).href)) as { ficha: { id: string; version: string; permisos: readonly string[] } };
    expect(ficha.id).toBe(f.name);
    expect(ficha.version).toBe(f.version);
    expect([...ficha.permisos].sort()).toEqual([...f.permisos].sort());
  });
});
