import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    // tsup injects a deprecated baseUrl option into its declaration build; TypeScript 6 rejects
    // it unless deprecations are acknowledged.
    dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
    // dist is cleaned once by scripts/clean.mjs before tsup runs, so the two entries never race.
    clean: false,
    target: "node20",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    clean: false,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
