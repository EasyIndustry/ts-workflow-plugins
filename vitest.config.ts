import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "*/test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Los tests de base comparten roles del servidor: un archivo a la vez.
    fileParallelism: false,
  },
});
