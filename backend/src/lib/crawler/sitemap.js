import { XMLParser } from "fast-xml-parser";
import { fetchSafely } from "./fetchSafely.js";

const MAX_CHILD_SITEMAPS = 2;
const parser = new XMLParser({ ignoreAttributes: false });

function extractLocs(node) {
  if (!node) return [];
  const arr = Array.isArray(node) ? node : [node];
  return arr.map((entry) => (typeof entry === "string" ? entry : entry?.loc)).filter(Boolean);
}

// Pure XML->shape parsing, split out from the fetch step so it's directly
// unit-testable without a network round-trip.
export function parseSitemapXml(xmlText) {
  const parsed = parser.parse(xmlText);

  if (parsed?.urlset?.url) {
    return { kind: "urlset", urls: extractLocs(parsed.urlset.url) };
  }

  if (parsed?.sitemapindex?.sitemap) {
    const childEntries = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];
    return { kind: "sitemapindex", childUrls: extractLocs(childEntries) };
  }

  return { kind: "unknown", urls: [] };
}

// Returns { urls, usedIndex } or null if no sitemap is usable — callers fall back
// to same-domain link discovery in that case. Bounded: at most `maxUrls` URLs are
// ever returned, and a sitemapindex is only followed into its first two children.
export async function discoverFromSitemap(origin, maxUrls) {
  let result;
  try {
    result = await fetchSafely(new URL("/sitemap.xml", origin).toString(), { allowedContentTypes: "any" });
  } catch {
    return null;
  }

  if (!result.body) return null;

  let parsed;
  try {
    parsed = parseSitemapXml(result.body);
  } catch {
    return null;
  }

  if (parsed.kind === "urlset") {
    return { urls: parsed.urls.slice(0, maxUrls), usedIndex: false };
  }

  if (parsed.kind === "sitemapindex") {
    const childLocs = parsed.childUrls.slice(0, MAX_CHILD_SITEMAPS);

    const urls = [];
    for (const childUrl of childLocs) {
      if (urls.length >= maxUrls) break;
      try {
        const childResult = await fetchSafely(childUrl, { allowedContentTypes: "any" });
        if (!childResult.body) continue;
        const childParsed = parseSitemapXml(childResult.body);
        if (childParsed.kind !== "urlset") continue;
        urls.push(...childParsed.urls.slice(0, maxUrls - urls.length));
      } catch {
        continue;
      }
    }
    return { urls, usedIndex: true };
  }

  return null;
}
