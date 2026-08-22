import { fetchSafely } from "./fetchSafely.js";

const USER_AGENT_TOKEN = "aicommercelayerbot";

// Best-effort MVP robots.txt handling: simple User-agent/Disallow group parsing,
// prefix-based path matching. Not a full robots.txt spec implementation (no
// wildcard patterns beyond prefix matching, no crawl-delay). Absence or failure
// to fetch/parse robots.txt is treated as "no restrictions," per convention.
export async function loadRobotsRules(origin) {
  try {
    const result = await fetchSafely(new URL("/robots.txt", origin).toString(), {
      allowedContentTypes: "any",
    });
    if (!result.body) return { disallow: [] };
    return parseRobots(result.body);
  } catch {
    return { disallow: [] };
  }
}

function parseRobots(text) {
  const disallow = [];
  let groupApplies = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "user-agent") {
      groupApplies = value === "*" || value.toLowerCase() === USER_AGENT_TOKEN;
    } else if (key === "disallow" && groupApplies && value) {
      disallow.push(value);
    }
  }

  return { disallow };
}

export function isPathDisallowed(rules, pathname) {
  return rules.disallow.some((rule) => pathname.startsWith(rule));
}
