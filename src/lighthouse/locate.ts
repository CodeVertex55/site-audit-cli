import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LocateInput = {
  explicitPath: string | null;
  cwd: string;
  pathEnv: string;
  platform: NodeJS.Platform;
};

const ENTRY_PARTS = ["cli", "index.js"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A package folder, or the cli/index.js file itself, to the entry file; null when it is not there. */
function fromExplicit(path: string): string | null {
  const absolute = resolve(path);
  if (isFile(absolute)) return absolute;
  const entry = join(absolute, ...ENTRY_PARTS);
  return isDirectory(absolute) && isFile(entry) ? entry : null;
}

/** `<dir>/node_modules/lighthouse/cli/index.js` in the folder and each parent folder. */
function fromWorkingDirectory(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const entry = join(dir, "node_modules", "lighthouse", ...ENTRY_PARTS);
    if (isFile(entry)) return entry;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The entry file beside a `lighthouse` or `lighthouse.cmd` launcher in one PATH folder. */
function fromPathFolder(dir: string): string | null {
  const launcher = join(dir, "lighthouse");
  if (!existsSync(launcher) && !existsSync(join(dir, "lighthouse.cmd"))) return null;

  const candidates = [
    join(dir, "node_modules", "lighthouse", ...ENTRY_PARTS),
    resolve(dir, "..", "lib", "node_modules", "lighthouse", ...ENTRY_PARTS),
  ];
  if (isSymlink(launcher)) {
    try {
      const target = realpathSync(launcher);
      if (target.replace(/\\/g, "/").endsWith("/cli/index.js")) candidates.push(target);
    } catch {
      // a dangling link is simply not a candidate
    }
  }
  return candidates.find(isFile) ?? null;
}

/**
 * Returns the absolute path of lighthouse's cli/index.js, or null. Only the file system is
 * consulted; no process is started.
 */
export function locateLighthouse(input: LocateInput): string | null {
  if (input.explicitPath !== null) return fromExplicit(input.explicitPath);

  const local = fromWorkingDirectory(input.cwd);
  if (local !== null) return local;

  const separator = input.platform === "win32" ? ";" : ":";
  for (const dir of input.pathEnv.split(separator)) {
    if (dir.trim() === "") continue;
    const found = fromPathFolder(resolve(dir));
    if (found !== null) return found;
  }
  return null;
}
