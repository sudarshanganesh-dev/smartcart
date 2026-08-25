// Kept separate from ai/buyer/systemPrompt.js by design (Phase 7 Decision
// 13) — merchant-intelligence prompting must never be mixed with the
// customer-facing buyer agent's prompt or conversation.
export const MERCHANDISING_SYSTEM_PROMPT = `You are a merchandising assistant for a merchant on SmartCart, an AI commerce marketplace. You will be given a summary of real, aggregated buyer demand that the merchant's current catalog does not satisfy, and a list of the merchant's own current APPROVED products (id, name, category, currency, price).

Hard rules, no exceptions:
- Propose a BUNDLE (combining 2 or more of the given existing products) only when the demand summary explicitly permits it — otherwise you MUST propose a VARIANT (a standalone new product idea, no components). The demand summary always tells you which is allowed for this specific opportunity.
- For a BUNDLE, componentProductIds must contain only exact IDs copied from the given product list — never invent, guess, or reuse an ID from outside that list.
- For a VARIANT, componentProductIds must be an empty array.
- The demand summary may state a HARD PRICE CEILING. If it does, whatever you propose (its component sum, for a BUNDLE) must not exceed that ceiling — this is a strict, non-negotiable requirement, not a preference, and the backend will reject and discard any proposal that violates it.
- Do NOT include a price, discount, or any numeric price figure anywhere in your response. The backend calculates the actual price from trusted data — you never decide it.
- Keep "name" and "description" concise and merchant-facing (a few sentences at most). Only reference facts present in the given demand summary or product list — never invent a product, price, or availability claim.
- Return only the structured fields requested — no extra commentary.`;

export function buildMerchandisingUserPrompt({ opportunitySummary, candidateProducts }) {
  const productLines = candidateProducts
    .map((p) => `- id=${p.id} | name="${p.name}" | category=${p.category || "none"} | price=${p.currency || ""} ${p.price ?? "unknown"}`)
    .join("\n");

  const catalogGap = opportunitySummary.catalogGap;
  const catalogGapLine = catalogGap?.hasApprovedMatch
    ? `- a related approved product already exists: "${catalogGap.cheapestApprovedProductName}" at ${catalogGap.cheapestApprovedPrice}${catalogGap.gapExists ? " (above the customer's stated budget)" : ""}`
    : `- no related approved product currently exists in the catalog`;

  // Deterministic, evidence-derived ceiling — never something Gemini
  // decides. Stated as a hard requirement here; the backend independently
  // re-checks and rejects the proposal before any Product is created, so
  // this line is a courtesy that reduces wasted/rejected proposals, never
  // the actual enforcement mechanism.
  const ceiling = opportunitySummary.demandCeiling;
  const ceilingLine =
    ceiling?.ceiling != null
      ? `- HARD PRICE CEILING: your proposed product's price must not exceed ₹${ceiling.ceiling}. This is derived from real buyer demand — ${ceiling.supportedSignals} of ${ceiling.knownBudgetSignals} known-budget signals stated a budget at or above this amount (${Math.round(ceiling.coverage * 100)}%). Do not exceed it for any reason.`
      : `- no reliable price ceiling exists from observed demand (no known buyer budgets) — price this reasonably for the merchant's existing catalog, but never invent a customer budget figure.`;

  const allowedTypes = opportunitySummary.allowedProposalTypes || ["VARIANT"];
  const typeLine =
    allowedTypes.length === 1 && allowedTypes[0] === "VARIANT"
      ? `- You MUST propose a VARIANT (a standalone new product idea, no components). BUNDLE is not permitted for this opportunity — there is no evidence buyers wanted multiple items together.`
      : `- Propose either a BUNDLE (2+ existing products) or a VARIANT, whichever genuinely fits this demand best.`;

  const variantMustBeCheaperLine =
    catalogGap?.hasApprovedMatch && catalogGap.gapExists
      ? `- Your proposed price must also be strictly lower than ₹${catalogGap.cheapestApprovedPrice} — the whole point of this draft is a genuinely cheaper alternative to that existing product.`
      : "";

  return `Demand summary:
- reason: ${opportunitySummary.reason}
- what buyers are asking for: ${opportunitySummary.label || "(unspecified)"}
- number of demand signals: ${opportunitySummary.eventCount}
${catalogGapLine}
${ceilingLine}
${typeLine}
${variantMustBeCheaperLine}

Merchant's current approved products:
${productLines || "(none)"}

Propose one idea that could satisfy this demand, following the hard requirements above exactly.`;
}
