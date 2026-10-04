export type RobotsRule = { allow: boolean; pattern: string };
export type RobotsGroup = { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null };
export type RobotsFile = { groups: RobotsGroup[]; sitemaps: string[] };

const MAX_CRAWL_DELAY_MS = 30000;

/** Parse robots.txt text. Tolerant: unknown directives and garbage lines are ignored. */
export function parseRobots(text: string): RobotsFile {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let current: RobotsGroup | null = null;
  let collectingAgents = false;

  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const hashAt = rawLine.indexOf("#");
    const line = (hashAt === -1 ? rawLine : rawLine.slice(0, hashAt)).trim();
    const colonAt = line.indexOf(":");
    if (colonAt === -1) continue;
    const name = line.slice(0, colonAt).trim().toLowerCase();
    const value = line.slice(colonAt + 1).trim();

    if (name === "user-agent") {
      if (value === "") continue;
      if (current === null || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value);
      collectingAgents = true;
    } else if (name === "allow" || name === "disallow") {
      if (current === null) continue;
      current.rules.push({ allow: name === "allow", pattern: value });
      collectingAgents = false;
    } else if (name === "crawl-delay") {
      if (current === null) continue;
      if (current.crawlDelay === null && /^\d+(?:\.\d+)?$/.test(value)) {
        current.crawlDelay = Number(value);
      }
      collectingAgents = false;
    } else if (name === "sitemap") {
      if (value !== "") sitemaps.push(value);
    }
  }

  return { groups, sitemaps };
}

/**
 * Combine every group that names the given agent (case-insensitive). Rules are
 * concatenated in file order and the first valid Crawl-delay is kept.
 */
function combinedGroup(file: RobotsFile, agent: string): RobotsGroup | null {
  const wanted = agent.toLowerCase();
  const matching = file.groups.filter((group) =>
    group.agents.some((name) => name.toLowerCase() === wanted),
  );
  const first = matching[0];
  if (first === undefined) return null;
  return {
    agents: first.agents,
    rules: matching.flatMap((group) => group.rules),
    crawlDelay: matching.find((group) => group.crawlDelay !== null)?.crawlDelay ?? null,
  };
}

// The selected group for each parsed file and token. A file is read many times during a crawl,
// and choosing the group walks every group in it.
const groupCache = new WeakMap<RobotsFile, Map<string, RobotsGroup | null>>();

/**
 * The group for a user-agent token: the longest agent that is a
 * case-insensitive prefix of the token, else "*", else null. All groups that
 * name the chosen agent are combined. The result is cached per file and token.
 */
export function selectGroup(file: RobotsFile, token: string): RobotsGroup | null {
  let byToken = groupCache.get(file);
  if (byToken === undefined) {
    byToken = new Map();
    groupCache.set(file, byToken);
  }
  const cached = byToken.get(token);
  if (cached !== undefined) return cached;
  const group = findGroup(file, token);
  byToken.set(token, group);
  return group;
}

function findGroup(file: RobotsFile, token: string): RobotsGroup | null {
  const lowered = token.toLowerCase();
  let bestAgent: string | null = null;
  for (const group of file.groups) {
    for (const agent of group.agents) {
      if (agent === "*") continue;
      const candidate = agent.toLowerCase();
      if (candidate.length > (bestAgent?.length ?? 0) && lowered.startsWith(candidate)) {
        bestAgent = candidate;
      }
    }
  }
  return combinedGroup(file, bestAgent ?? "*");
}

/**
 * Match a robots.txt path pattern against a path (with query). `*` matches any
 * run of characters and a trailing `$` anchors the end. Scans with indexOf, so
 * the cost is linear in the path for each segment and no RegExp is built from
 * the pattern.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");
  const first = segments[0] ?? "";

  if (!path.startsWith(first)) return false;
  if (segments.length === 1) return anchored ? path.length === first.length : true;

  let position = first.length;
  const lastIndex = segments.length - 1;
  for (let i = 1; i < lastIndex; i += 1) {
    const segment = segments[i] ?? "";
    const found = path.indexOf(segment, position);
    if (found === -1) return false;
    position = found + segment.length;
  }

  const last = segments[lastIndex] ?? "";
  if (anchored) {
    return path.length - last.length >= position && path.endsWith(last);
  }
  return path.indexOf(last, position) !== -1;
}

/**
 * Whether the path (including query) may be fetched. The longest matching
 * pattern wins, Allow wins ties, and an empty pattern has no effect.
 */
export function isAllowed(file: RobotsFile, token: string, path: string): boolean {
  const group = selectGroup(file, token);
  if (group === null) return true;
  let bestLength = -1;
  let allowed = true;
  for (const rule of group.rules) {
    if (rule.pattern === "" || !patternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      allowed = rule.allow;
    }
  }
  return allowed;
}

/** Crawl-delay for the token's group in milliseconds, clamped at 30 seconds. */
export function crawlDelayMs(
  file: RobotsFile,
  token: string,
): { ms: number | null; clamped: boolean } {
  const group = selectGroup(file, token);
  if (group === null || group.crawlDelay === null) return { ms: null, clamped: false };
  const ms = Math.round(group.crawlDelay * 1000);
  if (ms > MAX_CRAWL_DELAY_MS) return { ms: MAX_CRAWL_DELAY_MS, clamped: true };
  return { ms, clamped: false };
}

/** The "*" group disallows "/" and has no Allow rules. */
export function disallowsEverything(file: RobotsFile): boolean {
  const group = combinedGroup(file, "*");
  if (group === null) return false;
  const hasAllow = group.rules.some((rule) => rule.allow && rule.pattern !== "");
  const disallowsRoot = group.rules.some((rule) => !rule.allow && rule.pattern === "/");
  return disallowsRoot && !hasAllow;
}
