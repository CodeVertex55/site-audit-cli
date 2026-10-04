import { writeFile } from "node:fs/promises";
import { main } from "./run.js";

main(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `site-audit: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 70;
  },
);
