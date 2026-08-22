import dns from "node:dns/promises";
import { fetchSafely, MAX_RESPONSE_BYTES } from "./fetchSafely.js";
import { discoverPages } from "./discoverPages.js";
import { extractProductFromHtml } from "./extractProduct.js";
import { loadRobotsRules, isPathDisallowed } from "./robotsTxt.js";
import { isBlockedIp } from "./ssrfGuard.js";
import { importNormalizedRows } from "../catalogImport.js";
import { classifyCompatibility, classifyFetchErrorCode } from "./compatibilityResult.js";

export const MAX_PAGES = 20;
export const CRAWL_BUDGET_MS = 25000;

// Simple in-memory "one crawl per merchant at a time" guard — enough to stop
// trivial resource-exhaustion abuse for an MVP without a job-queue.
const activeCrawls = new Set();

function validateUrlSyntax(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

function describeFetchError(error) {
  const message = error?.message || "UNKNOWN_ERROR";
  switch (message) {
    case "TIMEOUT":
      return "Timed out while fetching this page.";
    case "TOO_MANY_REDIRECTS":
      return "Too many redirects.";
    case "RESPONSE_TOO_LARGE":
      return `Response exceeded the ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB limit.`;
    case "BLOCKED_IP":
      return "This page resolved to a blocked network address.";
    case "DNS_RESOLUTION_FAILED":
      return "Could not resolve this host.";
    case "UNSUPPORTED_SCHEME":
      return "Unsupported URL scheme.";
    default:
      if (message.startsWith("HTTP_")) return `Server responded with ${message.slice(5)}.`;
      return "Could not reach this page.";
  }
}

export async function crawlSite({ url: rawUrl, merchantId }) {
  const url = validateUrlSyntax(rawUrl);
  if (!url) {
    return { batchError: { error: "INVALID_URL" } };
  }

  try {
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (addresses.some((address) => isBlockedIp(address.address))) {
      return { batchError: { error: "URL_NOT_ALLOWED" } };
    }
  } catch {
    return { batchError: { error: "UNREACHABLE", message: "We couldn't reach the website. Check the URL and try again." } };
  }

  if (activeCrawls.has(merchantId)) {
    return { batchError: { error: "CRAWL_IN_PROGRESS" } };
  }
  activeCrawls.add(merchantId);

  const deadline = Date.now() + CRAWL_BUDGET_MS;

  try {
    const robots = await loadRobotsRules(url.origin);
    const { urls, discoveryMethod } = await discoverPages(url.toString(), MAX_PAGES);

    const pages = [];
    let stoppedEarly = false;

    // Signals gathered live, while the loop runs, so the compatibility result
    // can be derived from what actually happened rather than re-parsed from
    // formatted strings afterward.
    let robotsBlockedCount = 0;
    let accessDeniedCount = 0;
    let jsRenderedCount = 0;
    let networkFailureCount = 0;

    for (const pageUrl of urls) {
      if (Date.now() >= deadline) {
        stoppedEarly = true;
        break;
      }

      let pathname = "/";
      try {
        pathname = new URL(pageUrl).pathname;
      } catch {
        // keep default "/"
      }

      if (isPathDisallowed(robots, pathname)) {
        robotsBlockedCount += 1;
        pages.push({ url: pageUrl, outcome: "SKIPPED", reason: "disallowed by robots.txt" });
        continue;
      }

      let fetched;
      try {
        fetched = await fetchSafely(pageUrl);
      } catch (error) {
        const kind = classifyFetchErrorCode(error?.message);
        if (kind === "accessDenied") accessDeniedCount += 1;
        else if (kind === "networkFailure") networkFailureCount += 1;
        pages.push({ url: pageUrl, outcome: "FAILED", errors: [describeFetchError(error)] });
        continue;
      }

      if (fetched.skipped || !fetched.body) {
        pages.push({ url: pageUrl, outcome: "SKIPPED", reason: "non-HTML content type" });
        continue;
      }

      const extraction = await extractProductFromHtml(fetched.body);

      if (!extraction.hasAnyProductSignal) {
        if (extraction.likelyJsRendered) jsRenderedCount += 1;
        pages.push({ url: pageUrl, outcome: "SKIPPED", reason: "no product data found on this page" });
        continue;
      }

      pages.push({
        importable: true,
        item: {
          raw: extraction.fields,
          meta: { url: pageUrl, sourceUrl: fetched.finalUrl },
          extraWarnings: extraction.warnings,
        },
      });
    }

    const importItems = pages.filter((page) => page.importable).map((page) => page.item);
    const importResult = await importNormalizedRows(importItems, { merchantId, sourceType: "CRAWL" });

    const combined = [];
    let importIndex = 0;
    let skipped = 0;
    for (const page of pages) {
      if (page.importable) {
        combined.push(importResult.results[importIndex]);
        importIndex += 1;
      } else {
        if (page.outcome === "SKIPPED") skipped += 1;
        combined.push({ url: page.url, outcome: page.outcome, ...(page.reason ? { reason: page.reason } : {}), ...(page.errors ? { errors: page.errors } : {}) });
      }
    }

    // Every failure whose message indicates a SKU collision (either against an
    // existing catalog row, or between two pages in this same crawl) means the
    // page's data WAS successfully extracted — the failure is a data-collision
    // outcome, not a website-compatibility problem.
    const duplicateOfExistingCount = importResult.results.filter(
      (result) =>
        result.outcome === "FAILED" &&
        (result.errors || []).some((message) => message.includes("already exists for this merchant") || message.includes("duplicate SKU"))
    ).length;

    const compatibility = classifyCompatibility({
      imported: importResult.imported,
      withWarnings: importResult.withWarnings,
      failed: importResult.failed,
      pagesDiscovered: urls.length,
      robotsBlockedCount,
      accessDeniedCount,
      jsRenderedCount,
      networkFailureCount,
      duplicateOfExistingCount,
    });

    return {
      summary: {
        startUrl: url.toString(),
        discoveryMethod,
        pagesDiscovered: urls.length,
        pagesFetched: pages.length,
        imported: importResult.imported,
        withWarnings: importResult.withWarnings,
        failed: importResult.failed,
        skipped,
        stoppedEarly,
        compatibility,
        pages: combined,
      },
    };
  } finally {
    activeCrawls.delete(merchantId);
  }
}
