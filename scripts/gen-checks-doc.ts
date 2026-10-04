import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChecksReference } from "../src/run.js";

const target = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "checks.md");

await mkdir(dirname(target), { recursive: true });
await writeFile(target, renderChecksReference("markdown"), "utf8");
