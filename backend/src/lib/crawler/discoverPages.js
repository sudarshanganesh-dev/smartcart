import * as cheerio from "cheerio";
import { fetchSafely } from "./fetchSafely.js";
import { discoverFromSitemap } from "./sitemap.js";

const PRODUCT_PATH_HINTS = ["/product", "/products/", "/item", "/p/", "/shop/"];
const TRACKING_PARAM_PATTERN = /^(utm_|ref$|fbclid$|gclid$)/i;

export function normalizeUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM_PATTERN.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function looksLikeProductPath(pathname) {
  const lower = pathname.toLowerCase();
  return PRODUCT_PATH_HINTS.some((hint) => lower.includes(hint));
}

// Discovers candidate product page URLs: sitemap first, same-domain link crawl as
// a fallback, always including the submitted URL itself. Bounded to `maxPages`
// throughout — never expands beyond that regardless of how much a sitemap/page
// actually offers.
export async function discoverPages(startUrl, maxPages) {
  const startNormalized = normalizeUrl(startUrl, startUrl);
  const origin = new URL(startUrl).origin;
  const hostname = new URL(startUrl).hostname;

  const seen = new Set([startNormalized]);
  const ordered = [startNormalized];

  const sitemapResult = await discoverFromSitemap(origin, maxPages);
  if (sitemapResult && sitemapResult.urls.length > 0) {
    for (const rawUrl of sitemapResult.urls) {
      if (ordered.length >= maxPages) break;
      let normalized = normalizeUrl(rawUrl, origin);
      if (!normalized) continue;
      let candidateUrl;
      try {
        candidateUrl = new URL(normalized);
      } catch {
        continue;
      }

      if (candidateUrl.hostname !== hostname) {
        // The sitemap declared a different host than the one it was actually
        // fetched from (a common real-world misconfiguration — e.g. a template
        // placeholder domain the site owner never swapped in). The sitemap.xml
        // itself came from `origin`, which is the domain actually being
        // crawled, so that origin — not the declared host — is authoritative.
        // Re-anchor to it, keeping only the path/query; this never widens the
        // crawl beyond the domain being crawled, it only stops discarding
        // entries over a mismatched host string.
        normalized = normalizeUrl(candidateUrl.pathname + candidateUrl.search, origin);
        if (!normalized) continue;
        try {
          candidateUrl = new URL(normalized);
        } catch {
          continue;
        }
        if (candidateUrl.hostname !== hostname) continue; // still not same-domain — skip
      }

      if (seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
    return { urls: ordered.slice(0, maxPages), discoveryMethod: "sitemap" };
  }

  let startPage;
  try {
    startPage = await fetchSafely(startUrl);
  } catch {
    return { urls: ordered, discoveryMethod: "single-page" };
  }

  if (!startPage.body) {
    return { urls: ordered, discoveryMethod: "single-page" };
  }

  const $ = cheerio.load(startPage.body);
  const candidates = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = normalizeUrl(href, startUrl);
    if (!normalized || seen.has(normalized)) return;
    let candidateUrl;
    try {
      candidateUrl = new URL(normalized);
    } catch {
      return;
    }
    if (candidateUrl.hostname !== hostname) return; // same-domain only
    if (candidates.some((c) => c.url === normalized)) return; // dedupe within this page's own links
    candidates.push({ url: normalized, productLike: looksLikeProductPath(candidateUrl.pathname) });
  });

  candidates.sort((a, b) => Number(b.productLike) - Number(a.productLike));

  for (const candidate of candidates) {
    if (ordered.length >= maxPages) break;
    seen.add(candidate.url);
    ordered.push(candidate.url);
  }

  return {
    urls: ordered.slice(0, maxPages),
    discoveryMethod: ordered.length > 1 ? "link-crawl" : "single-page",
  };
}
