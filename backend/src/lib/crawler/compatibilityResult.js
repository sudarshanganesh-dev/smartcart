// Translates raw crawl-loop signals into one of three merchant-facing result
// codes. This is deliberately computed from signals gathered WHILE the crawl
// loop runs (robots-blocked count, access-denied count, etc.) rather than by
// re-parsing already-formatted error strings after the fact — the frontend
// then maps this structured code to copy, instead of guessing from arbitrary
// backend text.
//
// COMPATIBLE               — usable products imported, no warnings/failures.
// PARTIALLY_COMPATIBLE     — usable products imported, but some fields/pages
//                             had extraction warnings or couldn't be processed.
// AUTOMATIC_IMPORT_UNAVAILABLE — nothing usable was imported at all.
//
// An ordinary "this page has no product data" skip (e.g. the homepage) never
// counts against compatibility by itself — only real crawl-level problems do.
export function classifyCompatibility({
  imported,
  withWarnings,
  failed,
  pagesDiscovered,
  robotsBlockedCount,
  accessDeniedCount,
  jsRenderedCount,
  networkFailureCount,
  duplicateOfExistingCount = 0,
}) {
  if (imported > 0) {
    if (withWarnings === 0 && failed === 0) {
      return { result: "COMPATIBLE", reasonCode: null };
    }
    return { result: "PARTIALLY_COMPATIBLE", reasonCode: null };
  }

  // Nothing NEW was imported, but if every single failure is because the
  // product already exists in this merchant's catalog (matched by SKU), the
  // site's data was demonstrably extracted correctly — that's the only way we
  // could know it conflicts. That's a re-crawl of an already-imported catalog,
  // not a compatibility problem, so it must not be reported as one.
  if (
    failed > 0 &&
    duplicateOfExistingCount === failed &&
    robotsBlockedCount === 0 &&
    accessDeniedCount === 0 &&
    jsRenderedCount === 0 &&
    networkFailureCount === 0
  ) {
    return { result: "COMPATIBLE", reasonCode: null };
  }

  // Nothing usable was imported — pick the single most specific, most
  // actionable reason, in priority order.
  if (robotsBlockedCount > 0) {
    return { result: "AUTOMATIC_IMPORT_UNAVAILABLE", reasonCode: "ROBOTS_BLOCKED" };
  }
  if (accessDeniedCount > 0) {
    return { result: "AUTOMATIC_IMPORT_UNAVAILABLE", reasonCode: "ACCESS_DENIED" };
  }
  if (jsRenderedCount > 0) {
    return { result: "AUTOMATIC_IMPORT_UNAVAILABLE", reasonCode: "DYNAMIC_CONTENT" };
  }
  if (networkFailureCount > 0) {
    return { result: "AUTOMATIC_IMPORT_UNAVAILABLE", reasonCode: "NETWORK_UNREACHABLE" };
  }
  if (pagesDiscovered <= 1) {
    return { result: "AUTOMATIC_IMPORT_UNAVAILABLE", reasonCode: "NO_PRODUCT_PAGES_DISCOVERED" };
  }
  return { result: "AUTOMATIC_IMPORT_UNAVAILABLE", reasonCode: "UNKNOWN" };
}

const ACCESS_DENIED_HTTP_CODES = new Set(["HTTP_401", "HTTP_403", "HTTP_429"]);
const NETWORK_ERROR_CODES = new Set(["TIMEOUT", "UNREACHABLE", "DNS_RESOLUTION_FAILED", "TOO_MANY_REDIRECTS", "RESPONSE_TOO_LARGE", "BLOCKED_IP"]);

export function classifyFetchErrorCode(rawErrorMessage) {
  if (ACCESS_DENIED_HTTP_CODES.has(rawErrorMessage)) return "accessDenied";
  if (NETWORK_ERROR_CODES.has(rawErrorMessage)) return "networkFailure";
  if (typeof rawErrorMessage === "string" && rawErrorMessage.startsWith("HTTP_5")) return "networkFailure";
  return "other";
}
