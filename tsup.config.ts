import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  // tsup injects a deprecated baseUrl option into its declaration build; TypeScript 6 rejects
  // it unless deprecations are acknowledged.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  target: "node20",
});
