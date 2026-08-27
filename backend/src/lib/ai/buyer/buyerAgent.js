import { randomUUID } from "node:crypto";
import { sendChat } from "./provider.js";
import { TOOL_DEFINITIONS, TOOL_EXECUTORS, extractProductIds } from "./tools.js";
import { CART_TOOL_DEFINITIONS, CART_TOOL_EXECUTORS, resolveCheckoutOutcome } from "./cartTools.js";
import { PROPOSE_BUNDLE_TOOL, PROPOSE_BUNDLE_TOOL_NAME, resolveBundleProposalWithOptimizer } from "./bundleTools.js";
import { createEmptyCart, toCartDTO, findCartItem } from "./cart.js";
import { buildWhyFacts } from "./explain.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { getApprovedProductById } from "../../commerceService.js";
import { recordNoMatchDemandEvent, recordNoMoreOptionsDemandEvent, recordStockDemandEvent } from "../../intelligence/demandService.js";
import { findPriceAlternative, findStockAlternative } from "../../intelligence/conversionRecovery.js";

// Smallest useful in-memory conversation state — no Redis, no DB, no
// persistence across a server restart. Bounded on every axis so a long or
// abusive session can't grow memory/cost unboundedly.
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 20; // neutral turns, not raw provider tokens
// One higher than the previous bound: forcing every turn through a function
// call (including the finishing respond_to_customer call) means the final
// answer now always consumes its own iteration slot rather than arriving as
// free text, so a legitimate search + one retry + finalize sequence needs
// the extra room. Raised from 6 to 8 after live testing showed a real
// goal-shopping turn (several search_products angles + up to
// MAX_BUNDLE_ATTEMPTS propose_bundle tries + the finishing call) can
// legitimately need exactly 6, leaving zero margin and occasionally running
// out before respond_to_customer is ever reached.
const MAX_TOOL_ITERATIONS = 8;
// The system prompt asks the model to retry an empty search at most once,
// but that's a soft instruction the model doesn't always honor (observed
// retrying 4+ different search terms in testing). Enforced here instead:
// once this many empty search_products results have occurred in a turn, the
// tool set for the next call is shrunk to just the finishing tool, which
// deterministically forces a finalize since it's the only option left.
const MAX_EMPTY_SEARCH_ATTEMPTS = 2;
// Same idea as MAX_EMPTY_SEARCH_ATTEMPTS: once propose_bundle has failed
// (invalid items, mixed merchants, over budget, ...) this many times in one
// turn, the tool set shrinks to just the finishing tool so the model is
// forced to honestly report it couldn't find a good combination instead of
// retrying indefinitely (MAX_TOOL_ITERATIONS already bounds this too, but a
// dedicated cap gives a cleaner, earlier honest answer).
const MAX_BUNDLE_ATTEMPTS = 2;
// How many products are actually shown to the customer per presentation —
// the model may retrieve up to 10 candidates (tools.js), but only ever this
// many are ever displayed at once, whether on first presentation or a
// "show more" continuation.
const DISPLAY_CAP = 3;

const conversations = new Map(); // conversationId -> { messages, knownProductIds, everShownProductIds, searchContext, lastSingleCandidateId, cart }

// Not a commerce tool — never touches commerceService. It exists purely to
// force the model's final reply into a structured shape using the same
// function-calling mechanism already in place, instead of parsing/splitting
// free text on the backend.
const RESPOND_TOOL_NAME = "respond_to_customer";
const RESPOND_TOOL = {
  name: RESPOND_TOOL_NAME,
  description:
    "Call this exactly once, as the final step of your turn, to send your reply to the customer. Always finish this way instead of returning plain text.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "The main reply shown to the customer. Concise; do not repeat fields already shown in an attached product card, and do not end it with a follow-up or next-step question — the system appends an appropriate one automatically.",
      },
      productIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Only right after a search_products call this turn returned 4+ candidates: the IDs of the ones you're choosing to show first, best-match-first. The system enforces how many are actually shown and never shows a product not in your search results. Omit for anything else — a detail/availability turn, an error, plain chat, or a 'show more' request (use show_more_products for that instead).",
      },
    },
    required: ["message"],
  },
};

// A separate, unambiguous signal for "show me more/other/additional options"
// — kept distinct from respond_to_customer's productIds so this never has to
// be inferred from an optional field being present vs. merely forgotten.
// Calling it (even with an empty selection) always means "continue the
// existing search context"; not calling it always means "don't".
const SHOW_MORE_TOOL_NAME = "show_more_products";
const SHOW_MORE_TOOL = {
  name: SHOW_MORE_TOOL_NAME,
  description:
    "Call this when the customer asks to see more, other, or additional options from a search you already ran in this conversation (e.g. 'anything else?', 'show me others'). Do not call search_products again just to page through the same results — only call it again if the customer's request actually changed (different budget, category, etc). After this, still call respond_to_customer to send your reply.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      productIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Best-match-first IDs of additional candidates to show now, chosen only from the earlier search_products results in this conversation that have not already been shown to the customer.",
      },
    },
  },
};

// Cart tools (add_to_cart, view_cart, update_cart_item, remove_from_cart)
// live in cartTools.js. request_checkout is defined here instead because,
// like respond_to_customer and show_more_products, it's a terminal signal
// the orchestration loop handles specially (see the per-call loop below) —
// its outcome message is entirely backend-authored, never Gemini free text,
// since this is the one place a wrong word ("your order is placed") would
// be a real safety problem. It never creates a payment, order, checkout
// session, or Razorpay object of any kind — Phase 3C only reports readiness.
const REQUEST_CHECKOUT_TOOL_NAME = "request_checkout";
const REQUEST_CHECKOUT_TOOL = {
  name: REQUEST_CHECKOUT_TOOL_NAME,
  description:
    "Call this when the customer wants to check out or asks if they're ready to pay. Re-validates the cart and reports checkout readiness — it never creates a payment or order, since that capability doesn't exist yet.",
  parametersJsonSchema: { type: "object", properties: {} },
};

// followUp is a deterministic conversational CTA, never model-generated —
// Phase 3B has no order/cart/checkout capability, so wording is fixed and
// reviewed to only ever OFFER a next step, never claim one already happened.
// Phase 3C can revisit this once real order/cart actions exist.
//
// Which line is used is decided purely from structured tool-result state
// (candidate counts, which candidates have already been shown, and whether a
// repeated search still lands on the same single product) — never from
// parsing the model's own prose — so it can never claim options exist beyond
// what search_products actually returned.
const ORDER_ONLY_CTA = "Would you like me to order this?";
const ORDER_OR_BROADEN_CTA = "Would you like me to order this, or should I broaden the search?";
const ORDER_OR_BACK_CTA = "Would you like me to order this, or go back to the other options?";
const CHOOSE_ONE_CTA = "Which one would you like to go with?";
const MORE_OPTIONS_CTA = "Would you like to go with one of these, or should I show you more options?";
const BROADEN_SEARCH_CTA = "Would you like me to broaden the search?";
// Only ever used after a real add_to_cart/update_cart_item success this
// turn (see the cartMutationSucceeded check below) — never fired merely
// because the model said something that sounds like a cart update.
const CHECKOUT_OR_CONTINUE_CTA = "Would you like to proceed to checkout or continue shopping?";

// Resolves what to actually display and which CTA applies, for a search
// context that was either just created (fresh search this turn) or already
// existed (a "show more" continuation, or a plain re-presentation).
//
// Ranking/selection: for 1-3 total candidates there is no real choice to
// make, so every candidate is shown regardless of what the model asked for.
// For 4+ candidates, the model's requested productIds are honored, but only
// the subset that is (a) an actual candidate from this search and (b) not
// already shown — this is the enforcement point that makes it impossible
// for the model to invent a product ID or re-surface something already
// presented. If the model's selection is empty or entirely invalid, the
// first unseen candidates (in commerceService's own return order) are shown
// instead, so the feature degrades gracefully rather than failing silently.
function resolveDisplayAndCta({ searchContext, requestedIds, isRepeatSingle }) {
  const { candidateIds, candidates, shownProductIds } = searchContext;

  if (candidateIds.length === 0) {
    return { display: [], followUp: BROADEN_SEARCH_CTA };
  }

  const unseenBefore = candidateIds.filter((pid) => !shownProductIds.has(pid));
  if (unseenBefore.length === 0) {
    return { display: [], followUp: BROADEN_SEARCH_CTA, exhausted: true };
  }

  let idsToShow;
  if (shownProductIds.size === 0 && candidateIds.length <= 3) {
    idsToShow = candidateIds;
  } else {
    const requested = Array.isArray(requestedIds) ? requestedIds : [];
    const validUnseen = requested.filter((pid) => unseenBefore.includes(pid));
    const deduped = [...new Set(validUnseen)];
    idsToShow = deduped.length > 0 ? deduped.slice(0, DISPLAY_CAP) : unseenBefore.slice(0, DISPLAY_CAP);
  }

  idsToShow.forEach((pid) => shownProductIds.add(pid));

  let followUp;
  if (candidateIds.length === 1) {
    followUp = isRepeatSingle ? ORDER_OR_BROADEN_CTA : ORDER_ONLY_CTA;
  } else if (candidateIds.length <= 3) {
    followUp = CHOOSE_ONE_CTA;
  } else {
    const unseenAfter = candidateIds.length - shownProductIds.size;
    followUp = unseenAfter > 0 ? MORE_OPTIONS_CTA : BROADEN_SEARCH_CTA;
  }

  return { display: idsToShow.map((pid) => candidates[pid]), followUp };
}

// Combines whatever happened this turn (a fresh search, a "show more"
// selection against an existing context, a single-product detail lookup, a
// successful goal-shopping plan, or none of those) into the one
// {products, bundle, followUp} the customer actually sees. A successful plan
// this turn always wins the display slot — it replaces the normal product
// list rather than showing both, since the plan card is itself the complete
// presentation of those same products.
function resolveTurnOutcome({ searchOutcome, showMoreOutcome, discussedProduct, lastProducts, requestedProductIds, bundleOutcome, clarificationRequested, state }) {
  if (clarificationRequested) {
    // The clarifying question IS the entire reply — never paired with
    // product cards from an earlier search_products call this same turn,
    // which would send a contradictory signal right when SmartCart is
    // deliberately asking rather than guessing.
    return { products: [], bundle: null, followUp: null };
  }

  if (bundleOutcome) {
    // No follow-up bubble here — the plan card itself carries the "Add all
    // to cart" button, which is already the correct call to action. Adding
    // a second, text-only "would you like me to add these?" would just be
    // redundant with the button already on screen.
    return { products: [], bundle: bundleOutcome.bundle, followUp: null };
  }

  let outcome;
  if (searchOutcome) {
    const { display, followUp } = resolveDisplayAndCta({
      searchContext: state.searchContext,
      requestedIds: requestedProductIds,
      isRepeatSingle: searchOutcome.isRepeatSingle,
    });
    outcome = { products: display, followUp };
  } else if (showMoreOutcome) {
    // show_more_products resolves immediately when called (see the per-call
    // loop) so its own tool response can tell the model whether it's
    // exhausted — reuse that same resolution here rather than recomputing
    // (recomputing would double-mutate shownProductIds).
    outcome = { products: showMoreOutcome.display, followUp: showMoreOutcome.followUp };
  } else if (discussedProduct) {
    const hadAlternatives = Boolean(state.searchContext && state.searchContext.candidateIds.length > 1);
    outcome = { products: lastProducts, followUp: hadAlternatives ? ORDER_OR_BACK_CTA : ORDER_ONLY_CTA };
  } else {
    outcome = { products: [], followUp: null };
  }

  // Deterministic "why this?" decoration — the same trusted filters already
  // used for demand-event attribution, never anything Gemini claims. Kept
  // as a late decoration step (not baked into commerceService's own DTO) so
  // it stays purely additive and never touches product truth itself.
  const filters = state.searchContext?.filters || {};
  const decorated = outcome.products.map((product) => ({
    ...product,
    why: buildWhyFacts({ product, filters, maxBudget: filters.maxPrice ?? null }),
  }));

  // Single point where "actually shown to the customer" is recorded — this
  // is the strict grounding set cart mutations require (see
  // isGroundedForMutation in cartTools.js), distinct from and narrower than
  // knownProductIds (which also includes hidden, never-displayed candidates
  // from a search's larger retrieval batch).
  for (const product of decorated) {
    if (product && product.id) state.everShownProductIds.add(product.id);
  }

  return { products: decorated, bundle: null, followUp: outcome.followUp };
}

function getOrCreateConversation(conversationId) {
  if (typeof conversationId === "string" && conversations.has(conversationId)) {
    return { id: conversationId, state: conversations.get(conversationId) };
  }
  const id = randomUUID();
  // searchContext and lastSingleCandidateId persist across turns (unlike the
  // other, per-turn-only locals in handleMessage) so a later turn can tell
  // which candidates have already been shown, and whether a repeated search
  // still lands on the same single product as before.
  const state = {
    messages: [],
    knownProductIds: new Set(),
    everShownProductIds: new Set(),
    searchContext: null,
    lastSingleCandidateId: null,
    // Goal-shopping plan (internal name: bundle) — persists across turns
    // the same way searchContext does, so a later "Add all to cart" click
    // (a deterministic action, not itself a chat turn) still has the exact
    // validated plan to act on. Cleared once actually added (see
    // addBundleToCartForConversation) or replaced by a newer plan.
    bundleContext: null,
    cart: createEmptyCart(),
    // Phase 7: in-memory fast-path dedup for demand-event recording — the
    // durable @@unique([conversationId, groupKey]) constraint is the real
    // guarantee; this just avoids a redundant write attempt within the same
    // conversation.
    recordedDemandGroupKeys: new Set(),
    // Persists across turns (bugfix): readiness must survive an unrelated
    // message ("start", a question, small talk) between "checkout" and the
    // customer actually clicking the button — it's only invalidated by an
    // actual cart mutation (see cartMutationSucceeded below) or re-set by a
    // fresh request_checkout call, never by the mere passage of a turn.
    checkoutReady: false,
  };
  conversations.set(id, state);
  if (conversations.size > MAX_CONVERSATIONS) {
    const oldestKey = conversations.keys().next().value;
    conversations.delete(oldestKey);
  }
  return { id, state };
}

// Read-only accessor for the checkout route (Phase 4A) — returns the SAME
// live cart object the buyer agent mutates, never a copy, so revalidation
// performed by the checkout route (via cartTools.js's revalidateCart)
// persists back to this conversation exactly like view_cart/request_checkout
// already do. Returns null for an unknown conversationId; never creates one.
export function getCartForConversation(conversationId) {
  const state = conversations.get(conversationId);
  return state ? state.cart : null;
}

// Called only after successful backend payment-signature verification
// (Phase 4A Decision 3) — never from a frontend callback, modal dismissal,
// or create-order success. Resets to an empty cart; does nothing for an
// unknown conversationId.
export function clearCartForConversation(conversationId) {
  const state = conversations.get(conversationId);
  if (state) state.cart = createEmptyCart();
}

// Deterministic, non-Gemini action behind the "Add all to cart" button —
// mirrors how "Proceed to payment" is a dedicated button outside the chat
// loop, for the same reason: a wrong/partial multi-item mutation here would
// be a real problem, so it never goes through anything Gemini says.
//
// Two passes, never one: first re-validate EVERY item's current trusted
// state without mutating anything, then only apply if all of them pass —
// so the cart never ends up with half of a plan silently added. Reuses the
// exact same validation add_to_cart itself performs; nothing here is a
// parallel/looser copy of those rules.
export async function addBundleToCartForConversation(conversationId) {
  const state = conversations.get(conversationId);
  if (!state) return { error: "UNKNOWN_CONVERSATION" };

  const bundle = state.bundleContext;
  if (!bundle || !Array.isArray(bundle.items) || bundle.items.length === 0) {
    return { error: "NO_ACTIVE_PLAN" };
  }

  const blockers = [];
  for (const item of bundle.items) {
    const product = await getApprovedProductById(item.productId);
    if (!product) {
      blockers.push({ productId: item.productId, name: item.name, reason: "PRODUCT_UNAVAILABLE", message: "This product is no longer available." });
      continue;
    }
    if (product.availability === "OUT_OF_STOCK") {
      blockers.push({ productId: item.productId, name: item.name, reason: "OUT_OF_STOCK", message: "This product is currently out of stock." });
      continue;
    }
    const existing = findCartItem(state.cart, item.productId);
    const requestedTotalQty = (existing ? existing.quantity : 0) + item.quantity;
    if (product.availability === "UNKNOWN" && requestedTotalQty > 1) {
      blockers.push({
        productId: item.productId,
        name: item.name,
        reason: "QUANTITY_UNCONFIRMED",
        message: "The available quantity isn't confirmed, so only one can be added.",
      });
      continue;
    }
    if (product.stockQuantity !== null && requestedTotalQty > product.stockQuantity) {
      blockers.push({
        productId: item.productId,
        name: item.name,
        reason: "QUANTITY_EXCEEDS_STOCK",
        message: `Only ${product.stockQuantity} of this item are available.`,
      });
      continue;
    }
    if (state.cart.currency !== null && state.cart.currency !== product.currency) {
      blockers.push({ productId: item.productId, name: item.name, reason: "CURRENCY_CONFLICT", message: "This cart already contains items priced in a different currency." });
      continue;
    }
    if (state.cart.merchantId !== null && state.cart.merchantId !== product.merchant.id) {
      blockers.push({ productId: item.productId, name: item.name, reason: "MERCHANT_CONFLICT", message: "This cart already contains items from a different merchant." });
    }
  }

  if (blockers.length > 0) {
    return { error: "PLAN_ITEM_INVALID", blockers, cart: toCartDTO(state.cart) };
  }

  for (const item of bundle.items) {
    const result = await CART_TOOL_EXECUTORS.add_to_cart(
      { productId: item.productId, quantity: item.quantity },
      { cart: state.cart, everShownProductIds: state.everShownProductIds }
    );
    if (!result.ok) {
      // Extremely unlikely right after the pre-check pass above, but never
      // leave a half-applied cart if current state somehow still changed.
      return {
        error: "PLAN_ITEM_INVALID",
        blockers: [{ productId: item.productId, name: item.name, reason: result.error, message: result.message }],
        cart: toCartDTO(state.cart),
      };
    }
  }

  // Any real cart mutation invalidates prior checkout readiness (same rule
  // as every other cart-mutating tool) — and the actioned plan itself is
  // cleared so a stale plan can't be re-added a second time.
  state.checkoutReady = false;
  state.bundleContext = null;

  return { ok: true, cart: toCartDTO(state.cart) };
}

// Deterministic, non-Gemini action behind the customer product card's direct
// "Add to cart" button (Feature 3 demo-hardening) — same reasoning as
// addBundleToCartForConversation above: a real commerce mutation should
// never depend on what Gemini says. Reuses the EXACT SAME cart executor
// (CART_TOOL_EXECUTORS.add_to_cart) and grounding rule
// (isGroundedForMutation, via everShownProductIds) the conversational
// add_to_cart path already goes through — never a second, parallel
// validation. Always quantity 1, matching the conversational path's own
// default and the button's own single-click affordance.
export async function addProductToCartForConversation(conversationId, productId) {
  const state = conversations.get(conversationId);
  if (!state) return { error: "UNKNOWN_CONVERSATION" };

  const result = await CART_TOOL_EXECUTORS.add_to_cart(
    { productId, quantity: 1 },
    { cart: state.cart, everShownProductIds: state.everShownProductIds }
  );
  if (result.ok) {
    // Same rule every other cart-mutating tool follows: a real mutation
    // invalidates prior checkout readiness.
    state.checkoutReady = false;
  }
  return result;
}

// A naive slice(-N) can cut in the middle of a turn — between a model
// functionCall message and its paired tool functionResponse message — which
// Gemini's API rejects outright ("function call turn must come immediately
// after a user turn or a function response turn"). Longer Phase 3C cart
// conversations exercise this path more than Phase 3B's shorter ones did, so
// truncation only ever cuts at a "user" message boundary, keeping as many
// whole recent turns as fit under the limit (or, in the pathological case of
// one oversized turn, the entire most recent turn regardless of size —
// better than truncating mid-turn).
function truncateHistory(state) {
  if (state.messages.length <= MAX_MESSAGES_PER_CONVERSATION) return;

  const turnStarts = [];
  state.messages.forEach((message, index) => {
    if (message.role === "user") turnStarts.push(index);
  });

  for (const startIndex of turnStarts) {
    if (state.messages.length - startIndex <= MAX_MESSAGES_PER_CONVERSATION) {
      state.messages = state.messages.slice(startIndex);
      return;
    }
  }
  state.messages = state.messages.slice(turnStarts[turnStarts.length - 1]);
}

function truncateForLog(text, max = 200) {
  return typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;
}

// Development/demo observability only — never logs secrets, raw provider
// payloads, or the system prompt; tool results are logged as outcome +
// count/IDs, not full product bodies.
function logTurn(event) {
  console.log("[buyer-agent]", JSON.stringify(event));
}

function describeProviderError(code) {
  switch (code) {
    case "PROVIDER_UNAVAILABLE":
      return "The shopping assistant isn't available right now - please try again later.";
    case "TIMEOUT":
      return "That took a bit too long - please try again.";
    case "QUOTA_EXCEEDED":
      return "The shopping assistant is temporarily busy - please try again in a moment.";
    case "INVALID_API_KEY":
      return "The shopping assistant is misconfigured right now - please try again later.";
    case "MODEL_UNAVAILABLE":
      return "The shopping assistant is temporarily unavailable - please try again later.";
    case "NETWORK_ERROR":
      return "We couldn't reach the shopping assistant - please try again.";
    default:
      return "Something went wrong on our side - please try again.";
  }
}

// `sendChatFn` defaults to the real provider and is only ever overridden by
// tests (a fake provider standing in for Gemini) — production code always
// uses the default.
export async function handleMessage(conversationId, userMessage, { sendChatFn = sendChat } = {}) {
  const { id, state } = getOrCreateConversation(conversationId);
  state.messages.push({ role: "user", text: userMessage });

  // Snapshot conversation state as it stood BEFORE this turn — comparisons
  // below must reflect "the previous search", not anything this turn does.
  const priorSingleCandidateId = state.lastSingleCandidateId;

  const toolCallLog = [];
  let finalText = null;
  let finalFollowUp = null;
  let lastProducts = [];
  let discussedProduct = false;
  let searchOutcome = null; // set when search_products is called this turn
  let requestedProductIds = null;
  let showMoreOutcome = null; // resolved {display, followUp}, set immediately when show_more_products is called
  let emptySearchCount = 0;
  let checkoutOutcome = null; // set immediately when request_checkout is called; short-circuits everything else
  let cartMutationSucceeded = false; // true if add_to_cart/update_cart_item actually succeeded this turn
  let bundleOutcome = null; // {bundle} on the most recent successful propose_bundle call this turn, else null
  let bundleAttemptCount = 0;
  let bundleToShow = null; // the plan actually returned to the customer this turn, if any
  // True when propose_bundle returned NEEDS_CLARIFICATION this turn — this
  // deliberately suppresses normal product/plan display for the turn
  // (see resolveTurnOutcome), so the customer sees ONLY the clarifying
  // question, never a contradictory product list from an earlier
  // search_products call in the same turn.
  let clarificationRequested = false;
  // Every distinct real, APPROVED product SmartCart's search_products calls
  // returned THIS turn, keyed by id — this is the grounded candidate pool
  // the Decision Engine (planOptimizer.js, via bundleTools.js) selects the
  // final plan from, and also what the trace's "checked" count reflects.
  // Populated unconditionally for every search_products call this turn,
  // regardless of which one becomes the "active" display context.
  const turnCheckedProducts = new Map();
  // True once any search_products call THIS turn has returned real
  // candidates — guards against a later, genuinely-empty search for a
  // different angle (e.g. goal-shopping searching "coffee" then
  // "chocolate") from erasing an earlier successful one within the same
  // turn (see the search_products handling below).
  let searchSucceededThisTurn = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const tools =
      emptySearchCount >= MAX_EMPTY_SEARCH_ATTEMPTS || bundleAttemptCount >= MAX_BUNDLE_ATTEMPTS
        ? [RESPOND_TOOL]
        : [...TOOL_DEFINITIONS, RESPOND_TOOL, SHOW_MORE_TOOL, ...CART_TOOL_DEFINITIONS, REQUEST_CHECKOUT_TOOL, PROPOSE_BUNDLE_TOOL];
    const result = await sendChatFn({
      messages: state.messages,
      tools,
      systemPrompt: SYSTEM_PROMPT,
    });

    if (result.type === "error") {
      logTurn({ conversationId: id, userMessage: truncateForLog(userMessage), providerError: result.code });
      // Do not keep the failed turn in history as if it succeeded.
      state.messages.pop();
      return {
        conversationId: id,
        message: describeProviderError(result.code),
        products: [],
        bundle: null,
        followUp: null,
        cart: toCartDTO(state.cart),
        checkoutReady: state.checkoutReady, // a transient provider error doesn't invalidate prior readiness
      };
    }

    if (result.type === "text") {
      // Defensive fallback only — with tool-calling forced to ANY mode the
      // model should always call respond_to_customer, but a provider can
      // occasionally return plain (even empty) text instead.
      const content = typeof result.content === "string" ? result.content.trim() : "";
      finalText = content !== "" ? content : "Sorry, I didn't quite catch that - could you rephrase?";
      const outcome = resolveTurnOutcome({
        searchOutcome,
        showMoreOutcome,
        discussedProduct,
        lastProducts,
        requestedProductIds,
        bundleOutcome,
        clarificationRequested,
        state,
      });
      lastProducts = outcome.products;
      bundleToShow = outcome.bundle;
      finalFollowUp = cartMutationSucceeded ? CHECKOUT_OR_CONTINUE_CTA : outcome.followUp;
      state.messages.push({ role: "assistant", text: finalText });
      break;
    }

    // result.type === "tool_calls"
    state.messages.push({ role: "assistant", functionCalls: result.calls, rawModelTurn: result.rawModelTurn });

    const responses = [];
    let respondArgs = null;

    for (const call of result.calls) {
      if (call.name === RESPOND_TOOL_NAME) {
        respondArgs = call.args || {};
        responses.push({ id: call.id, name: call.name, result: { received: true } });
        toolCallLog.push({ name: call.name, outcome: "OK" });
        continue;
      }

      if (call.name === SHOW_MORE_TOOL_NAME) {
        if (state.searchContext) {
          const requested = Array.isArray(call.args?.productIds) ? call.args.productIds : [];
          showMoreOutcome = resolveDisplayAndCta({
            searchContext: state.searchContext,
            requestedIds: requested,
            isRepeatSingle: false,
          });
          // Resolved here (not deferred) so the tool response itself can
          // tell the model whether it's exhausted, letting it write an
          // honest message — this also means shownProductIds is mutated
          // exactly once for this call, not re-resolved at finalization.
          responses.push({
            id: call.id,
            name: call.name,
            result: {
              shownCount: showMoreOutcome.display.length,
              remainingUnseenCount:
                state.searchContext.candidateIds.length - state.searchContext.shownProductIds.size,
              exhausted: Boolean(showMoreOutcome.exhausted),
            },
          });
          if (showMoreOutcome.exhausted) {
            try {
              await recordNoMoreOptionsDemandEvent({ conversationId: id, searchContext: state.searchContext }, state);
            } catch (error) {
              console.error("[buyer-agent] demand recording failed:", error.message);
            }
          }
        } else {
          showMoreOutcome = { display: [], followUp: null };
          responses.push({ id: call.id, name: call.name, result: { error: "NO_ACTIVE_SEARCH_CONTEXT" } });
        }
        toolCallLog.push({ name: call.name, outcome: "OK" });
        continue;
      }

      if (call.name === PROPOSE_BUNDLE_TOOL_NAME) {
        const bundleResult = await resolveBundleProposalWithOptimizer(call.args || {}, {
          cart: state.cart,
          knownProductIds: state.knownProductIds,
          checkedProducts: [...turnCheckedProducts.values()],
        });
        bundleAttemptCount += 1;
        if (bundleResult.ok) {
          state.bundleContext = bundleResult.bundle;
          for (const item of bundleResult.bundle.items) {
            state.knownProductIds.add(item.productId);
            state.everShownProductIds.add(item.productId);
          }
          bundleOutcome = { bundle: bundleResult.bundle };
          responses.push({ id: call.id, name: call.name, result: { ok: true, bundle: bundleResult.bundle } });
        } else {
          // A failed attempt always overwrites any earlier one this turn —
          // same "latest attempt is the truth" rule search_products already
          // follows, even when that latest attempt is empty/invalid.
          bundleOutcome = null;
          if (bundleResult.error === "NEEDS_CLARIFICATION") {
            clarificationRequested = true;
          }
          responses.push({
            id: call.id,
            name: call.name,
            result: {
              error: bundleResult.error,
              message: bundleResult.message,
              ...(bundleResult.total ? { total: bundleResult.total, maxBudget: bundleResult.maxBudget } : {}),
            },
          });
        }
        toolCallLog.push({ name: call.name, outcome: bundleResult.ok ? "OK" : bundleResult.error });
        continue;
      }

      if (call.name === REQUEST_CHECKOUT_TOOL_NAME) {
        checkoutOutcome = await resolveCheckoutOutcome(state.cart);
        responses.push({ id: call.id, name: call.name, result: { ready: checkoutOutcome.ready } });
        toolCallLog.push({ name: call.name, outcome: checkoutOutcome.ready ? "READY" : "NOT_READY" });
        continue;
      }

      if (CART_TOOL_EXECUTORS[call.name]) {
        let cartResult;
        try {
          cartResult = await CART_TOOL_EXECUTORS[call.name](call.args || {}, {
            cart: state.cart,
            everShownProductIds: state.everShownProductIds,
          });
        } catch (error) {
          console.error("[buyer-agent] cart tool execution failed:", call.name, error);
          cartResult = { error: "TOOL_EXECUTION_FAILED" };
        }
        if (cartResult.ok && (call.name === "add_to_cart" || call.name === "update_cart_item")) {
          cartMutationSucceeded = true;
        }
        if (cartResult.ok) {
          // Any real cart mutation (including removal) invalidates prior
          // checkout readiness — the customer must request_checkout again
          // to re-confirm before the payment button reappears.
          state.checkoutReady = false;
        }
        // Phase 7: Revenue Recovery — record a demand event for a real
        // cart-stage failure. cartTools.js itself is untouched; this only
        // re-reads the same trusted product data it already validated
        // against, using the actual attempted quantity for this call.
        if (
          (cartResult.error === "OUT_OF_STOCK" || cartResult.error === "QUANTITY_EXCEEDS_STOCK") &&
          (call.name === "add_to_cart" || call.name === "update_cart_item") &&
          typeof call.args?.productId === "string"
        ) {
          try {
            const product = await getApprovedProductById(call.args.productId);
            if (product) {
              const existing = findCartItem(state.cart, call.args.productId);
              const requestedQuantity =
                call.name === "update_cart_item"
                  ? call.args.quantity
                  : (existing ? existing.quantity : 0) + (Number.isInteger(call.args.quantity) ? call.args.quantity : 1);
              await recordStockDemandEvent(
                {
                  conversationId: id,
                  cartErrorCode: cartResult.error,
                  product,
                  requestedQuantity,
                  availableQuantity: product.stockQuantity,
                },
                state
              );
              // Phase 7: Conversion Recovery for a cart-stage stock failure.
              // The cart is merchant-locked (Phase 4B), so any alternative
              // must come from the SAME merchant — never a different one.
              const alternatives = await findStockAlternative({
                merchantId: product.merchant.id,
                category: product.category,
                excludeProductId: product.id,
                excludeIds: state.everShownProductIds,
              });
              if (alternatives.length > 0) {
                cartResult.alternatives = alternatives;
                for (const alt of alternatives) {
                  state.knownProductIds.add(alt.id);
                  state.everShownProductIds.add(alt.id);
                }
              }
            }
          } catch (error) {
            console.error("[buyer-agent] demand recording failed:", error.message);
          }
        }
        toolCallLog.push({ name: call.name, outcome: cartResult.error || "OK" });
        responses.push({ id: call.id, name: call.name, result: cartResult });
        continue;
      }

      const executor = TOOL_EXECUTORS[call.name];
      let toolResult;

      if (!executor) {
        toolResult = { error: "UNKNOWN_TOOL" };
      } else {
        try {
          toolResult = await executor(call.args || {}, { knownProductIds: state.knownProductIds });
        } catch (error) {
          console.error("[buyer-agent] tool execution failed:", call.name, error);
          toolResult = { error: "TOOL_EXECUTION_FAILED" };
        }
      }

      for (const productId of extractProductIds(call.name, toolResult)) {
        state.knownProductIds.add(productId);
      }

      if (call.name === "search_products" && Array.isArray(toolResult.products)) {
        for (const product of toolResult.products) {
          turnCheckedProducts.set(product.id, product);
        }
        const candidateIds = toolResult.products.map((p) => p.id);
        const isRepeatSingle =
          candidateIds.length === 1 && priorSingleCandidateId !== null && candidateIds[0] === priorSingleCandidateId;

        // A fresh search normally starts a brand-new recommendation context
        // — this is what makes a substantially different request (new
        // budget, new category, ...) naturally discard stale candidates
        // rather than needing separate "did the topic change" detection.
        // EXCEPTION: if an earlier search_products call already succeeded
        // THIS SAME turn (e.g. goal-shopping searching "coffee" then
        // "chocolate", where the second angle has no match), a later empty
        // result must not erase what was already found — the customer would
        // otherwise see an empty product card under text that confidently
        // described a real item. A later search that also succeeds still
        // replaces the context as before (last real result wins).
        const shouldReplaceContext = candidateIds.length > 0 || !searchSucceededThisTurn;
        if (shouldReplaceContext) {
          state.searchContext = {
            candidateIds,
            candidates: Object.fromEntries(toolResult.products.map((p) => [p.id, p])),
            shownProductIds: new Set(),
            // Phase 7: the filters that produced this search context, kept
            // only for demand-event attribution/value (recordNoMoreOptionsDemandEvent) —
            // never re-shown to the customer or the model. Reaching this point
            // already proves minPrice/maxPrice (if present) passed tools.js's
            // own parsePriceRange validation — otherwise toolResult.products
            // would not exist and this whole branch would not run.
            filters: {
              query: call.args?.query,
              category: call.args?.category,
              merchantId: call.args?.merchantId,
              minPrice: call.args?.minPrice,
              maxPrice: call.args?.maxPrice,
            },
          };
          state.lastSingleCandidateId = candidateIds.length === 1 ? candidateIds[0] : null;
          searchOutcome = { isRepeatSingle };
        }

        if (candidateIds.length === 0) {
          emptySearchCount += 1;
          try {
            await recordNoMatchDemandEvent(
              {
                conversationId: id,
                merchantId: call.args?.merchantId,
                category: call.args?.category,
                query: call.args?.query,
                minPrice: call.args?.minPrice,
                maxPrice: call.args?.maxPrice,
              },
              state
            );
          } catch (error) {
            console.error("[buyer-agent] demand recording failed:", error.message);
          }
          // Phase 7: Conversion Recovery — deterministic, no Gemini call.
          // Budget (maxPrice) and merchant constraint (if any) are always
          // preserved; only query wording/category scope are ever broadened.
          try {
            const alternatives = await findPriceAlternative({
              merchantId: call.args?.merchantId,
              category: call.args?.category,
              query: call.args?.query,
              maxPrice: call.args?.maxPrice,
              excludeIds: state.everShownProductIds,
            });
            if (alternatives.length > 0) {
              toolResult.alternatives = alternatives;
              for (const alt of alternatives) {
                state.knownProductIds.add(alt.id);
                state.everShownProductIds.add(alt.id);
              }
            }
          } catch (error) {
            console.error("[buyer-agent] conversion recovery failed:", error.message);
          }
        } else {
          emptySearchCount = 0;
          searchSucceededThisTurn = true;
        }
      } else if (call.name === "get_product" && !toolResult.error) {
        lastProducts = [toolResult];
        discussedProduct = true;
      } else if (call.name === "check_availability" && !toolResult.error) {
        discussedProduct = true;
      }

      toolCallLog.push({
        name: call.name,
        args: call.args,
        outcome: toolResult.error || "OK",
        resultCount: Array.isArray(toolResult.products) ? toolResult.products.length : undefined,
      });

      responses.push({ id: call.id, name: call.name, result: toolResult });
    }

    state.messages.push({ role: "tool", responses });

    if (checkoutOutcome) {
      // Entirely backend-authored (see resolveCheckoutOutcome) — never
      // overwritten by whatever respond_to_customer may also have said in
      // the same turn, and no further CTA is appended to it.
      finalText = checkoutOutcome.message;
      finalFollowUp = null;
      lastProducts = [];
      bundleToShow = null;
      state.checkoutReady = checkoutOutcome.ready;
      break;
    }

    if (respondArgs) {
      const message = typeof respondArgs.message === "string" ? respondArgs.message.trim() : "";
      finalText = message !== "" ? message : "Sorry, I didn't quite catch that - could you rephrase?";
      requestedProductIds = Array.isArray(respondArgs.productIds) ? respondArgs.productIds : null;
      const outcome = resolveTurnOutcome({
        searchOutcome,
        showMoreOutcome,
        discussedProduct,
        lastProducts,
        requestedProductIds,
        bundleOutcome,
        clarificationRequested,
        state,
      });
      lastProducts = outcome.products;
      bundleToShow = outcome.bundle;
      // A successful cart mutation this turn always wins the CTA slot —
      // never fired merely because the model's own text sounds like a cart
      // update; only a real add_to_cart/update_cart_item success sets this.
      finalFollowUp = cartMutationSucceeded ? CHECKOUT_OR_CONTINUE_CTA : outcome.followUp;
      break;
    }
  }

  truncateHistory(state);

  if (finalText === null) {
    finalText = "I'm having trouble completing that right now - could you try rephrasing?";
    finalFollowUp = null;
    lastProducts = [];
    bundleToShow = null;
  }

  logTurn({
    conversationId: id,
    userMessage: truncateForLog(userMessage),
    toolCalls: toolCallLog,
    replyLength: finalText.length,
    hasFollowUp: finalFollowUp !== null,
    productsShown: lastProducts.length,
  });

  return {
    conversationId: id,
    message: finalText,
    products: lastProducts,
    bundle: bundleToShow,
    followUp: finalFollowUp,
    cart: toCartDTO(state.cart),
    checkoutReady: state.checkoutReady,
  };
}
