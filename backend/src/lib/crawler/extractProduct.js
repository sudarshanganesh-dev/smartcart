import * as cheerio from "cheerio";
import { interpretAmbiguousField } from "../ai/aiProvider.js";

const SCHEMA_AVAILABILITY_MAP = {
  instock: "IN_STOCK",
  in_stock: "IN_STOCK",
  limitedavailability: "IN_STOCK",
  outofstock: "OUT_OF_STOCK",
  out_of_stock: "OUT_OF_STOCK",
  soldout: "OUT_OF_STOCK",
  discontinued: "OUT_OF_STOCK",
};

function mapSchemaAvailability(raw) {
  if (!raw) return undefined;
  const token = String(raw).split("/").pop().toLowerCase();
  return SCHEMA_AVAILABILITY_MAP[token];
}

function firstNumberFromPriceText(text) {
  const match = String(text).match(/\d[\d,]*(\.\d{1,2})?/);
  if (!match) return null;
  const num = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

// --- Tier 1: JSON-LD ---

function collectJsonLdNodes($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && Array.isArray(item["@graph"])) {
          nodes.push(...item["@graph"]);
        } else {
          nodes.push(item);
        }
      }
    } catch {
      // Malformed JSON-LD block on this page — skip it, not fatal to the page.
    }
  });
  return nodes;
}

function isProductNode(node) {
  if (!node || typeof node !== "object") return false;
  const type = node["@type"];
  return Array.isArray(type) ? type.includes("Product") : type === "Product";
}

function extractFromJsonLd($) {
  const productNode = collectJsonLdNodes($).find(isProductNode);
  if (!productNode) return {};

  const fields = {};
  if (typeof productNode.name === "string") fields.name = productNode.name;
  if (typeof productNode.description === "string") fields.description = productNode.description;
  if (typeof productNode.sku === "string") fields.sku = productNode.sku;
  else if (typeof productNode.mpn === "string") fields.sku = productNode.mpn;
  if (typeof productNode.category === "string") fields.category = productNode.category;

  let offer = productNode.offers;
  if (Array.isArray(offer)) {
    offer = offer.find((candidate) => candidate && (candidate.price ?? candidate.priceSpecification?.price)) || offer[0];
  }

  if (offer && typeof offer === "object") {
    const priceRaw = offer.price ?? offer.priceSpecification?.price;
    if (priceRaw !== undefined && priceRaw !== null && priceRaw !== "") {
      const price = typeof priceRaw === "number" ? priceRaw : Number(String(priceRaw).replace(/,/g, ""));
      if (Number.isFinite(price)) fields.price = price;
    }
    const currencyRaw = offer.priceCurrency ?? offer.priceSpecification?.priceCurrency;
    if (typeof currencyRaw === "string") fields.currency = currencyRaw;
    const availability = mapSchemaAvailability(offer.availability);
    if (availability) fields.availability = availability;
  }

  return fields;
}

// --- Tier 1b: OpenGraph / product meta tags ---

function extractFromOpenGraph($) {
  const fields = {};
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDescription =
    $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content");
  const priceAmount = $('meta[property="product:price:amount"]').attr("content");
  const priceCurrency = $('meta[property="product:price:currency"]').attr("content");

  if (ogTitle) fields.name = ogTitle;
  if (ogDescription) fields.description = ogDescription;
  if (priceAmount) {
    const price = Number(String(priceAmount).replace(/,/g, ""));
    if (Number.isFinite(price)) fields.price = price;
  }
  if (priceCurrency) fields.currency = priceCurrency;

  return fields;
}

// --- Tier 2: deterministic HTML fallback ---

function extractNameFallback($) {
  const title = $("title").first().text().trim();
  if (title) {
    const cleaned = title.split(/[|\-–—]/)[0].trim();
    if (cleaned) return cleaned;
  }
  return $("h1").first().text().trim() || undefined;
}

function extractDescriptionFallback($) {
  const meta = $('meta[name="description"]').attr("content");
  if (meta && meta.trim()) return meta.trim();
  let found;
  $("p").each((_, el) => {
    if (found) return;
    const text = $(el).text().trim();
    if (text.length > 40) found = text;
  });
  return found;
}

function extractCategoryFallback($) {
  const crumbs = [];
  $('nav[class*="breadcrumb" i] a, [class*="breadcrumb" i] a').each((_, el) => {
    const text = $(el).text().trim();
    if (text) crumbs.push(text);
  });
  return crumbs.length > 0 ? crumbs[crumbs.length - 1] : undefined;
}

// cheerio's $(el).text() concatenates sibling elements' text with NO inserted
// whitespace (e.g. "<p>SKU: X</p><p>In Stock</p>" becomes "SKU: XIn Stock"),
// which silently breaks \b word-boundary regexes wherever one element's text
// runs directly into the next. Join block-level elements' OWN text with spaces
// instead of reading .text() off a single ancestor.
const TEXT_BEARING_SELECTOR =
  "p, li, span, div, h1, h2, h3, h4, h5, h6, td, th, a, button, label, strong, em, b, small, dd, dt";

function getVisibleText($) {
  const chunks = [];
  $(TEXT_BEARING_SELECTOR).each((_, el) => {
    const ownText = $(el).clone().children().remove().end().text().trim();
    if (ownText) chunks.push(ownText);
  });
  const bodyOwnText = $("body").clone().children().remove().end().text().trim();
  if (bodyOwnText) chunks.push(bodyOwnText);
  return chunks.join(" ");
}

function extractSkuFallback($) {
  const text = getVisibleText($);
  const match = text.match(/\b(?:SKU|Item\s*#|Product\s*code)\s*[:#]?\s*([A-Za-z0-9_-]{2,})/i);
  return match ? match[1] : undefined;
}

function extractAvailabilityFallback($) {
  const text = getVisibleText($).toLowerCase();
  if (/\bout of stock\b|\bsold out\b/.test(text)) return "OUT_OF_STOCK";
  if (/\bin stock\b|\badd to cart\b/.test(text)) return "IN_STOCK";
  return undefined;
}

// Conservative, tiered price evidence gathering — never just "the first number
// on the page." Strongly-identified candidates (itemprop/price-labelled elements,
// excluding elements that look like a struck-through "was" price) are preferred;
// bare currency-looking text anywhere on the page is a much weaker signal used
// only when nothing stronger exists.
function extractPriceCandidates($) {
  const strong = [];

  $('[itemprop="price"]').each((_, el) => {
    const value = $(el).attr("content") || $(el).text();
    if (value && value.trim()) strong.push(value.trim());
  });

  $('[class*="price" i]').each((_, el) => {
    const classAttr = ($(el).attr("class") || "").toLowerCase();
    if (/was|strike|original|compare/.test(classAttr)) return;
    const text = $(el).text().trim();
    if (text && /\d/.test(text)) strong.push(text);
  });

  const bodyText = getVisibleText($);
  const weak = [...bodyText.matchAll(/[₹$€£]\s?\d[\d,]*(\.\d{1,2})?/g)].map((match) => match[0]);

  return { strong: [...new Set(strong)], weak: [...new Set(weak)] };
}

async function resolvePrice($, warnings) {
  const { strong, weak } = extractPriceCandidates($);

  if (strong.length === 1) {
    const price = firstNumberFromPriceText(strong[0]);
    return price !== null ? price : undefined;
  }

  if (strong.length > 1) {
    // Genuine ambiguity: more than one strongly-identified price element (e.g. an
    // original price and a sale price both marked up as "price"). Evidence exists,
    // but which one is *the* product price isn't deterministic — this is exactly
    // the narrow case tier 3 exists for.
    const result = await interpretAmbiguousField({ field: "price", candidates: strong, context: getVisibleText($).slice(0, 2000) });
    if (result.value && strong.some((candidate) => candidate.includes(result.value))) {
      const price = firstNumberFromPriceText(result.value);
      if (price !== null) {
        warnings.push("AI-assisted: price");
        return price;
      }
    }
    warnings.push("multiple price candidates found - could not confidently determine the product price");
    return undefined;
  }

  if (weak.length === 1) {
    const price = firstNumberFromPriceText(weak[0]);
    if (price !== null) warnings.push("low-confidence price extraction");
    return price !== null ? price : undefined;
  }

  if (weak.length > 1) {
    warnings.push("multiple price candidates found - could not confidently determine the product price");
  }

  return undefined; // no evidence at all — stays unknown, no AI call, no extra warning
}

export async function extractProductFromHtml(html) {
  const $ = cheerio.load(html);
  const warnings = [];

  const jsonLd = extractFromJsonLd($);
  const og = extractFromOpenGraph($);

  // JSON-LD (tier 1) wins over OpenGraph (tier 1b) wherever both supply a field.
  const fields = { ...og, ...jsonLd };

  if (fields.name === undefined) fields.name = extractNameFallback($);
  if (fields.description === undefined) fields.description = extractDescriptionFallback($);
  if (fields.category === undefined) fields.category = extractCategoryFallback($);
  if (fields.sku === undefined) fields.sku = extractSkuFallback($);
  if (fields.availability === undefined) fields.availability = extractAvailabilityFallback($);

  if (fields.price === undefined) {
    const price = await resolvePrice($, warnings);
    if (price !== undefined) fields.price = price;
  }

  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }

  // A page title/H1 exists on virtually every page, so it can't be the signal
  // that "this is a product page." Require actual product-specific evidence: a
  // JSON-LD Product node (any field), or a commerce fact (price/SKU/availability)
  // found via OpenGraph or the deterministic HTML tier.
  const hasAnyProductSignal = Boolean(
    Object.keys(jsonLd).length > 0 ||
      og.price !== undefined ||
      fields.price !== undefined ||
      fields.sku !== undefined ||
      fields.availability !== undefined
  );

  // Heuristic only, not a guarantee: a page with no product signal, almost no
  // real visible text, but a non-trivial amount of markup and at least one
  // <script> tag is plausibly a client-side-rendered shell whose real content
  // never appears in the HTML we fetched (we don't run JavaScript). Used only
  // to give the merchant a more useful reason than "no product data found" —
  // never used to fabricate product fields.
  const likelyJsRendered = !hasAnyProductSignal && $("script").length > 0 && getVisibleText($).trim().length < 150 && html.length > 2000;

  return { fields, warnings, hasAnyProductSignal, likelyJsRendered };
}
