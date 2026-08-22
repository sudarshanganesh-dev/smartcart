// Provider-agnostic interface for AI-assisted interpretation during crawling.
// Crawler code must only ever call interpretAmbiguousField() — never import a
// vendor SDK directly — so wiring in a real provider later touches only this file.
//
// No provider is configured in this pass: no SDK dependency, no API key required.
// interpretAmbiguousField() always resolves to "no interpretation available," so
// genuinely ambiguous fields correctly fall through to "leave unknown, surface a
// warning" rather than ever fabricating a value. Callers must still independently
// verify any returned value is grounded in the supplied candidates before trusting
// it (defense in depth — this contract does not rely solely on the provider
// behaving correctly).

export function isProviderConfigured() {
  return Boolean(process.env.AI_PROVIDER_API_KEY);
}

/**
 * @param {object} input
 * @param {"price"|"availability"|"sku"|"stockQuantity"|"category"|"description"|"name"} input.field
 * @param {string[]} input.candidates - already-extracted page text snippets that are evidence for this field
 * @param {string} [input.context] - bounded excerpt of surrounding page text, for disambiguation context only
 * @returns {Promise<{ value: string|null, reason: string }>}
 */
export async function interpretAmbiguousField({ field, candidates, context } = {}) {
  if (!isProviderConfigured()) {
    return { value: null, reason: "NO_PROVIDER_CONFIGURED" };
  }

  // A real provider implementation would go here. It must be instructed to only
  // select/quote from `candidates`/`context`, never compose a new value — and
  // callers additionally re-verify the result is a substring of the evidence
  // before trusting it, regardless of what the provider returns.
  void field;
  void candidates;
  void context;
  return { value: null, reason: "NOT_IMPLEMENTED" };
}
