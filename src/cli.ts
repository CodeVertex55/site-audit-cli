import { constants } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { main } from "./run.js";

/**
 * True when the report file can be written: an existing file is not a folder and is writable,
 * and a new file's folder exists and is writable. Nothing is created or truncated.
 */
async function canWrite(path: string): Promise<boolean> {
  const target = resolve(path);
  try {
    const info = await stat(target);
    if (info.isDirectory()) return false;
    await access(target, constants.W_OK);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") return false;
  }
  try {
    const folder = dirname(target);
    if (!(await stat(folder)).isDirectory()) return false;
    await access(folder, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

main(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  canWrite,
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
