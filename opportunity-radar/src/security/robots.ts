/**
 * Minimal robots.txt evaluator: User-agent groups, Allow/Disallow with
 * longest-match precedence, `*` wildcards and `$` end anchors. Crawl-delay
 * and sitemaps are ignored (we fetch one page per user action).
 */
interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface Robots {
  isAllowed(path: string, userAgent?: string): boolean;
}

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // "Disallow:" = allow all
      current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  return {
    isAllowed(path: string, userAgent = "*"): boolean {
      const ua = userAgent.toLowerCase();
      const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
      const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
      const rules = applicable.flatMap((g) => g.rules);
      let best: { rule: Rule; length: number } | null = null;
      for (const rule of rules) {
        if (!matches(rule.pattern, path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow && !best.rule.allow)) best = { rule, length };
      }
      return best ? best.rule.allow : true;
    },
  };
}

function matches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}
