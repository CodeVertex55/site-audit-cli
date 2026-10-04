// Removes dist once before a build. The two tsup entries build in parallel, so neither of them
// cleans the folder itself.
import { rmSync } from "node:fs";
import { URL } from "node:url";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
