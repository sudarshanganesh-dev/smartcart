import { resolveAndCheckHost } from "./ssrfGuard.js";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 8000;

const USER_AGENT = "AICommerceLayerBot/0.1 (+MVP catalog import crawler)";
const DEFAULT_ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

function assertSupportedScheme(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("UNSUPPORTED_SCHEME");
  }
}

// Fetches a single URL with SSRF guarding, a manual (re-validated) redirect loop,
// a hard timeout, and a hard response-size cap. `allowedContentTypes` defaults to
// HTML-only for product pages; callers fetching robots.txt/sitemap.xml pass a
// looser allowlist (or "any") since those are auxiliary, low-risk, well-known paths
// whose parsers already fail safely on unexpected content.
export async function fetchSafely(startUrl, { allowedContentTypes = DEFAULT_ALLOWED_CONTENT_TYPES } = {}) {
  let currentUrl = new URL(startUrl);
  let redirects = 0;

  while (true) {
    assertSupportedScheme(currentUrl);
    await resolveAndCheckHost(currentUrl.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("TIMEOUT");
      throw new Error("UNREACHABLE");
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("UNREACHABLE");
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new Error("TOO_MANY_REDIRECTS");
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const contentTypeAllowed =
      allowedContentTypes === "any" || allowedContentTypes.some((allowed) => contentType.includes(allowed));

    if (!contentTypeAllowed) {
      return { finalUrl: currentUrl.toString(), contentType, skipped: true, body: null };
    }

    const body = await readBodyWithLimit(response);
    return { finalUrl: currentUrl.toString(), contentType, skipped: false, body };
  }
}

async function readBodyWithLimit(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
    return text;
  }

  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
