import { toMinorUnits } from "./cart.js";

// Deterministic "why this?" fact-building — Gemini never sees or generates
// this. Every fact is independently re-derived from real product data plus
// the customer's own already-trusted stated constraints (search filters /
// plan preferences/budget), never from any LLM claim about the product.
// A fact is included only when it can be proven true here; nothing unproven
// is ever added, and nothing here is chain-of-thought — it's a flat list of
// boolean checks.

export function containsKeyword(product, keyword) {
  if (typeof keyword !== "string") return false;
  const needle = keyword.trim().toLowerCase();
  if (needle === "") return false;
  return [product.name, product.description, product.category].some(
    (field) => typeof field === "string" && field.toLowerCase().includes(needle)
  );
}

function isWithinBudget(priceString, budgetString) {
  if (priceString == null || budgetString == null) return false;
  try {
    return toMinorUnits(priceString) <= toMinorUnits(String(budgetString));
  } catch {
    return false;
  }
}

// `filters` is the trusted search_products args from this conversation
// (query/category/minPrice/maxPrice) — never customer free text.
// `preferences`/`maxBudget` are the same kind of trusted, already-validated
// values used by the goal-shopping plan path. Both are optional and either
// can be empty; only facts that are actually provable from `product` are
// ever returned.
export function buildWhyFacts({ product, filters = {}, preferences = [], maxBudget = null }) {
  const facts = [];
  const budgetLimit = maxBudget ?? filters.maxPrice ?? null;

  if (budgetLimit != null && product.price != null && isWithinBudget(product.price, budgetLimit)) {
    facts.push({ id: "budget", label: `₹${product.price} - within your ₹${Number(budgetLimit).toFixed(2)} budget` });
  }
  if (
    filters.category &&
    typeof product.category === "string" &&
    product.category.toLowerCase() === filters.category.toLowerCase()
  ) {
    facts.push({ id: "category", label: `Matches "${filters.category}"` });
  }
  if (filters.query && containsKeyword(product, filters.query)) {
    facts.push({ id: "query", label: `Matches "${filters.query}"` });
  }
  for (const preference of preferences) {
    if (containsKeyword(product, preference)) {
      facts.push({ id: `preference:${preference}`, label: `Matches your "${preference}" preference` });
    }
  }
  if (product.availability === "IN_STOCK") {
    facts.push({ id: "availability", label: "Currently available" });
  }
  return facts;
}
