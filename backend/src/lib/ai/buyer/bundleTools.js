import { getApprovedProductById } from "../../commerceService.js";
import { parsePriceRange } from "../../commerceValidation.js";
import { toMinorUnits, fromMinorUnits } from "./cart.js";
import { buildWhyFacts } from "./explain.js";
import { selectBestPlan, computeCheckedBreakdown } from "./planOptimizer.js";

// "SmartCart Plan" (customer-facing wording lives entirely in the frontend
// and in respond_to_customer's guidance below) — internally this is still
// called a "bundle"/"plan proposal" tool, kept in its own file the same way
// cartTools.js's mutations are kept separate from tools.js's read-only
// commerce tools. Gemini decides WHICH real products solve the customer's
// goal; every other fact (existence, approval, merchant, price, stock,
// budget, total) is independently re-verified here, exactly like
// opportunityService.generateDraftForOpportunity re-verifies a
// merchandising proposal. Nothing here is ever trusted from Gemini except
// which already-returned real IDs to combine.

export const PROPOSE_BUNDLE_TOOL_NAME = "propose_bundle";
const MAX_PLAN_ITEMS = 6;

export const PROPOSE_BUNDLE_TOOL = {
  name: PROPOSE_BUNDLE_TOOL_NAME,
  description:
    "Call this ONLY when the customer's goal genuinely needs two or more complementary real products (a themed gift, an occasion with several stated preferences, catering a group) — never for a request one product can satisfy. Every productId must have already appeared in a search_products result earlier in THIS conversation; never invent one. Call search_products (possibly more than once, for different angles of the goal) before this — UNLESS the customer stated a group size but named no specific needs at all, in which case call this immediately with an empty items array instead of searching (see the items field). The backend independently re-checks price, availability, stock, merchant, and budget — you never state a total, and you never need to. If the customer stated a group size but gave no specific needs and no variety request, this returns NEEDS_CLARIFICATION instead of a plan — in that case, ask the single short question in its message and wait for their reply instead of retrying or searching.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      planLabel: { type: "string", description: "A short 2-4 word name for this shopping plan, e.g. 'Birthday Surprise'." },
      preferences: {
        type: "array",
        items: { type: "string" },
        description: "Short keywords capturing preferences the customer actually stated (e.g. 'chocolate', 'coffee'). Never invent one they didn't say or clearly imply.",
      },
      maxBudget: {
        type: "string",
        description: 'Customer\'s stated maximum total budget as a decimal string, e.g. "2000.00", only if they gave one.',
      },
      groupSize: {
        type: "integer",
        description:
          "The number of people this is for, ONLY if the customer explicitly stated a count (e.g. 'for 10 people', '6 guests', 'a team of 12'). Never invent or estimate this — omit it entirely if no count was stated. This is NOT the same as a product quantity (e.g. 'I need 10 of the coffee mugs' is a cart quantity, not a group size) — never confuse the two.",
      },
      varietyRequested: {
        type: "boolean",
        description:
          "Set true ONLY if the customer's own words explicitly ask for variety, a mix, or multiple different types of things — independent of whether they also named specific items. Omit or leave false otherwise, even for a large group — a stated group size alone never implies variety was requested.",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productId: { type: "string" },
            quantity: { type: "integer", description: "Defaults to 1." },
          },
          required: ["productId"],
        },
        description:
          "2 or more real product IDs from this conversation's own search_products results. May be an empty array ONLY when you're calling this purely to report a stated group size before searching for anything (no specific needs named yet) — in that case, don't search first, just call this with an empty items array, empty preferences, and no varietyRequested, and let the backend ask the right clarifying question.",
      },
    },
    required: ["items"],
  },
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function cleanPreferences(preferences) {
  if (!Array.isArray(preferences)) return [];
  return preferences
    .filter((p) => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().slice(0, 40))
    .slice(0, 6);
}

// `context.cart` / `context.knownProductIds` mirror exactly what
// cartTools.js's executors already receive — no new grounding concept.
export async function resolveBundleProposal(args, context) {
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return { error: "INVALID_ARGUMENTS", message: "At least one item is required." };
  }
  if (args.items.length > MAX_PLAN_ITEMS) {
    return { error: "TOO_MANY_ITEMS", message: `A plan can include at most ${MAX_PLAN_ITEMS} products.` };
  }

  // Duplicate productIds are combined (quantities summed) rather than
  // rejected or double-counted as separate lines — the same "already in
  // the list, increase it" treatment add_to_cart already gives a repeat id.
  const quantityByProductId = new Map();
  for (const item of args.items) {
    if (!item || !isNonEmptyString(item.productId)) {
      return { error: "INVALID_ARGUMENTS", message: "Each item needs a productId." };
    }
    let quantity = 1;
    if (item.quantity !== undefined) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return { error: "INVALID_ARGUMENTS", message: "quantity must be a positive integer." };
      }
      quantity = item.quantity;
    }
    quantityByProductId.set(item.productId, (quantityByProductId.get(item.productId) || 0) + quantity);
  }

  const uniqueIds = [...quantityByProductId.keys()];

  // Grounding: identical rule to get_product/check_availability — a
  // productId that was never actually returned by a tool in this
  // conversation can never reach this far, so a hallucinated/fake id is
  // rejected before a single database lookup happens.
  for (const productId of uniqueIds) {
    if (!context.knownProductIds.has(productId)) {
      return {
        error: "UNKNOWN_PRODUCT_REFERENCE",
        message: "One of these products was not part of this conversation's own results.",
      };
    }
  }

  // Independent re-fetch of REAL, trusted product truth. getApprovedProductById
  // returns null for a product that doesn't exist, was deleted, or is
  // PENDING_REVIEW/REJECTED — a foreign-merchant id resolves fine here (it
  // may well be a real approved product) and is instead caught by the
  // merchant-boundary check below.
  const products = [];
  for (const productId of uniqueIds) {
    const product = await getApprovedProductById(productId);
    if (!product) {
      return { error: "PRODUCT_UNAVAILABLE", message: "One of these products is no longer available.", productId };
    }
    products.push(product);
  }

  // Merchant boundary: a plan must resolve to exactly one merchant so
  // "Add all to cart" can succeed under the existing one-merchant-per-cart
  // rule (Phase 4B) without a partial/confusing failure later.
  const merchantCounts = new Map();
  for (const product of products) {
    merchantCounts.set(product.merchant.id, (merchantCounts.get(product.merchant.id) || 0) + 1);
  }
  const merchantIds = [...merchantCounts.keys()];
  let allowedMerchantId = context.cart?.merchantId || null;
  if (allowedMerchantId) {
    if (products.some((p) => p.merchant.id !== allowedMerchantId)) {
      return {
        error: "MIXED_MERCHANT_ITEMS",
        message: "Your cart already has items from one merchant — a plan can only combine products from that same merchant.",
      };
    }
  } else if (merchantIds.length > 1) {
    const [dominantMerchantId] = [...merchantCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      error: "MIXED_MERCHANT_ITEMS",
      message: "These products are from more than one merchant — a plan can only combine products from a single merchant.",
      dominantMerchantId,
    };
  } else {
    allowedMerchantId = merchantIds[0] || null;
  }

  // Availability/stock — only ever recommend what's genuinely purchasable
  // right now; an OUT_OF_STOCK/UNKNOWN or insufficient-quantity item fails
  // the whole proposal rather than being silently dropped or included.
  const unavailable = [];
  for (const product of products) {
    const quantity = quantityByProductId.get(product.id);
    if (product.availability !== "IN_STOCK") {
      unavailable.push({ productId: product.id, name: product.name, reason: "NOT_AVAILABLE" });
      continue;
    }
    if (product.stockQuantity !== null && quantity > product.stockQuantity) {
      unavailable.push({
        productId: product.id,
        name: product.name,
        reason: "INSUFFICIENT_STOCK",
        availableQuantity: product.stockQuantity,
      });
    }
  }
  if (unavailable.length > 0) {
    return {
      error: "ITEMS_UNAVAILABLE",
      message: "One or more of these products is not currently available in the requested quantity.",
      items: unavailable,
    };
  }

  // A plan may now be a single product — the Decision Engine (see
  // planOptimizer.js) is explicitly allowed to conclude that one product is
  // the strongest verified answer to a stated goal, rather than padding a
  // plan with an unnecessary second item. Gemini's own guidance still tells
  // it to prefer the normal single-product path for a simple ask; this
  // floor is only a backend safety net for the ambiguous cases.
  const currencies = new Set(products.map((p) => p.currency));
  if (currencies.size !== 1) {
    return { error: "CURRENCY_CONFLICT", message: "These products use different currencies and cannot form one plan." };
  }
  const currency = products[0].currency;

  // Trusted subtotal: exact integer minor-unit arithmetic, the same
  // toMinorUnits/fromMinorUnits helpers used everywhere else money is
  // summed in this codebase. Never anything Gemini could have implied.
  const totalMinor = products.reduce((sum, p) => sum + toMinorUnits(p.price) * quantityByProductId.get(p.id), 0);
  const subtotal = fromMinorUnits(totalMinor);

  let maxBudget = null;
  if (args.maxBudget !== undefined && args.maxBudget !== null) {
    const parsed = parsePriceRange(undefined, String(args.maxBudget));
    if (parsed.error) {
      return { error: "INVALID_ARGUMENTS", message: "maxBudget must be a valid decimal amount, e.g. \"2000.00\"." };
    }
    maxBudget = parsed.maxPrice.toFixed(2);
    if (totalMinor > toMinorUnits(maxBudget)) {
      return {
        error: "OVER_BUDGET",
        message: `This combination totals ${currency} ${subtotal}, which is over the ${currency} ${maxBudget} budget.`,
        total: subtotal,
        maxBudget,
      };
    }
  }

  const planLabel = isNonEmptyString(args.planLabel) ? args.planLabel.trim().slice(0, 60) : "Shopping plan";
  const preferences = cleanPreferences(args.preferences);
  // Context only, echoed straight back to the customer — never used here or
  // anywhere downstream to claim serving/capacity coverage. See
  // planOptimizer.js for the one place it's actually allowed to matter
  // (it isn't — variety ranking is gated on varietyRequested, not this).
  const groupSize = parseGroupSizeOrNull(args.groupSize);
  const itemCount = [...quantityByProductId.values()].reduce((sum, q) => sum + q, 0);
  const remaining = maxBudget != null ? fromMinorUnits(toMinorUnits(maxBudget) - totalMinor) : null;

  const items = products.map((product) => {
    const quantity = quantityByProductId.get(product.id);
    const lineTotal = fromMinorUnits(toMinorUnits(product.price) * quantity);
    return {
      productId: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      currency: product.currency,
      availability: product.availability,
      stockQuantity: product.stockQuantity,
      merchant: product.merchant,
      quantity,
      lineTotal,
      why: buildWhyFacts({ product, preferences, maxBudget }),
    };
  });

  // Plan-level facts (the top checkmark row) — deliberately built from the
  // SAME already-computed per-item `why` facts above, never a second,
  // independent re-derivation. This is the single trusted fact source: a
  // preference only shows at plan level if some item's own verified facts
  // already prove it; there is no other path that could disagree with that.
  // "Budget" and "availability" are not aggregations — by this point in the
  // function, validation above has already guaranteed the trusted total
  // fits maxBudget and every item is IN_STOCK, so both are already-proven
  // truths, not per-item roll-ups.
  const planWhy = [];
  // Always true by this point (every item above was independently re-fetched
  // and confirmed APPROVED) — not an aggregation, an already-proven fact.
  planWhy.push({ id: "approved", label: "Products approved" });
  if (maxBudget != null) {
    planWhy.push({ id: "budget", label: "Within your budget" });
  }
  for (const preference of preferences) {
    const factId = `preference:${preference}`;
    const provenByAnyItem = items.some((item) => item.why.some((fact) => fact.id === factId));
    if (provenByAnyItem) {
      planWhy.push({ id: factId, label: `Matches ${preference}` });
    }
  }
  planWhy.push({ id: "availability", label: "All items currently available" });

  return {
    ok: true,
    bundle: {
      planLabel,
      preferences,
      groupSize,
      merchantId: allowedMerchantId,
      currency,
      subtotal,
      maxBudget,
      remaining,
      itemCount,
      items,
      why: planWhy,
    },
  };
}

function parseMaxBudgetOrNull(rawMaxBudget) {
  if (rawMaxBudget === undefined || rawMaxBudget === null) return null;
  const parsed = parsePriceRange(undefined, String(rawMaxBudget));
  if (parsed.error) return null;
  return parsed.maxPrice.toFixed(2);
}

// Bounded, positive-integer-only — anything else (a fraction, a negative
// number, an absurd value, free text) is treated as "no group size stated"
// rather than guessed at. Never used for capacity/serving math — see the
// comment where this is consumed in resolveBundleProposal.
const MAX_GROUP_SIZE = 500;
function parseGroupSizeOrNull(rawGroupSize) {
  if (rawGroupSize === undefined || rawGroupSize === null) return null;
  const value = Number(rawGroupSize);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GROUP_SIZE) return null;
  return value;
}

// Derives the SmartCart Decision Engine's trace for a successfully validated
// bundle. Deliberately reuses `bundle.why` (the single, already-audited
// verification source) to compute preference coverage rather than tracking
// a second, independent notion of "covered" — so VERIFY can never disagree
// with what the Decision Engine reports.
function attachDecisionTrace(result, { selectionMethod, checkedProducts, evaluatedCount }) {
  const { bundle } = result;
  const matchedPreferences = bundle.preferences.filter((preference) =>
    bundle.why.some((fact) => fact.id === `preference:${preference}`)
  );
  const unverifiedPreferences = bundle.preferences.filter((preference) => !matchedPreferences.includes(preference));
  // True whenever there is nothing left unverified — including the case of
  // zero stated preferences, where there was never anything to fall short
  // of. This is what respond_to_customer's narration guidance keys off of
  // to decide whether an unqualified success sentence is honest.
  const coverageComplete = unverifiedPreferences.length === 0;

  // SEARCH/FILTER/OPTIMIZE counts only mean anything when the optimizer's
  // own pick is what's shown — computing them from `checkedProducts` in
  // fallback mode would be actively misleading (e.g. "0 checked, 0
  // eligible" next to a real 2-item plan, when this turn simply never ran
  // a fresh search because the items were already known from earlier in
  // the conversation). Rather than showing a fake zero, these are `null`
  // in fallback mode, and a fallback-specific fact — how many of the
  // FINAL bundle's items were actually re-validated — is exposed instead.
  const optimizerFields =
    selectionMethod === "optimizer"
      ? (() => {
          const { eligibleCount, overBudgetCount, unavailableCount } = computeCheckedBreakdown(checkedProducts, bundle.maxBudget);
          return { checkedCount: checkedProducts.length, eligibleCount, overBudgetCount, unavailableCount, evaluatedCount, validatedItemCount: null };
        })()
      : { checkedCount: null, eligibleCount: null, overBudgetCount: null, unavailableCount: null, evaluatedCount: null, validatedItemCount: bundle.items.length };

  return {
    ...result,
    bundle: {
      ...bundle,
      trace: {
        selectionMethod,
        ...optimizerFields,
        matchedPreferences,
        unverifiedPreferences,
        preferencesTotal: bundle.preferences.length,
        coverageComplete,
      },
    },
  };
}

function buildClarificationMessage(groupSize) {
  return `For a group of ${groupSize}, would you like more variety of different items, or more of just one or two things?`;
}

// The SmartCart Decision Engine's entry point — called instead of
// resolveBundleProposal directly. Flow (never bypassed):
//   grounded candidates (this turn's real search_products results)
//   -> a deterministic clarification gate (below) — skips straight past
//      the optimizer entirely when there isn't enough structured
//      information to build a confident plan
//   -> planOptimizer.selectBestPlan ranks valid combinations
//   -> each ranked candidate is tried through the SAME, UNMODIFIED
//      resolveBundleProposal (fresh re-validation — grounding, approval,
//      merchant, stock, currency, budget, total — exactly as before)
//   -> first one that passes wins
//   -> if the optimizer found nothing, threw, or every one of its
//      candidates failed fresh validation, fall back to validating
//      Gemini's own originally-submitted items — the exact, unchanged,
//      already-shipped path — so a bug or an edge case here can never
//      break plan creation, only make it slightly less optimized.
export async function resolveBundleProposalWithOptimizer(args, context) {
  const checkedProducts = [...new Map((context.checkedProducts || []).map((product) => [product.id, product])).values()];
  const preferences = cleanPreferences(args.preferences);
  const maxBudget = parseMaxBudgetOrNull(args.maxBudget);
  const groupSize = parseGroupSizeOrNull(args.groupSize);
  const varietyRequested = args.varietyRequested === true;

  // Deterministic clarification gate — fires ONLY when a group size was
  // explicitly stated but nothing else actionable was given (no named
  // needs, no stated variety intent). This is not a failure: asking one
  // short question here is deliberately preferred over silently building
  // a technically-valid but potentially weak plan (e.g. one cheap item for
  // a stated group of 10). Never fires for a request with any explicit
  // preference or variety signal, and never fires when no group size was
  // stated at all — so ordinary goal-shopping is completely unaffected.
  if (groupSize != null && groupSize > 1 && preferences.length === 0 && !varietyRequested) {
    return { error: "NEEDS_CLARIFICATION", message: buildClarificationMessage(groupSize), groupSize };
  }

  let optimized = null;
  try {
    optimized = selectBestPlan({ checkedProducts, preferences, maxBudget, varietyRequested });
  } catch (error) {
    console.error("[bundle-tools] plan optimizer failed:", error.message);
    optimized = null;
  }

  if (optimized && optimized.ranked.length > 0) {
    for (const candidate of optimized.ranked) {
      let result;
      try {
        result = await resolveBundleProposal({ ...args, items: candidate.items }, context);
      } catch (error) {
        console.error("[bundle-tools] optimizer candidate validation failed:", error.message);
        continue;
      }
      if (result.ok) {
        return attachDecisionTrace(result, { selectionMethod: "optimizer", checkedProducts, evaluatedCount: optimized.evaluatedCount });
      }
      // This candidate no longer holds up under fresh validation (e.g. a
      // stock/price change in the last moment) — try the next-ranked one.
    }
  }

  // Fallback: Gemini's own originally-submitted items, through the exact
  // same validation path as always.
  const fallbackResult = await resolveBundleProposal(args, context);
  if (!fallbackResult.ok) return fallbackResult;
  return attachDecisionTrace(fallbackResult, { selectionMethod: "fallback", checkedProducts, evaluatedCount: null });
}
