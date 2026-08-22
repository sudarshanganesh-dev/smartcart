import { randomUUID } from "node:crypto";
import { sendChat } from "./provider.js";
import { TOOL_DEFINITIONS, TOOL_EXECUTORS, extractProductIds } from "./tools.js";
import { CART_TOOL_DEFINITIONS, CART_TOOL_EXECUTORS, resolveCheckoutOutcome } from "./cartTools.js";
import { createEmptyCart, toCartDTO } from "./cart.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

// Smallest useful in-memory conversation state — no Redis, no DB, no
// persistence across a server restart. Bounded on every axis so a long or
// abusive session can't grow memory/cost unboundedly.
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 20; // neutral turns, not raw provider tokens
// One higher than the previous bound: forcing every turn through a function
// call (including the finishing respond_to_customer call) means the final
// answer now always consumes its own iteration slot rather than arriving as
// free text, so a legitimate search + one retry + finalize sequence needs
// the extra room.
const MAX_TOOL_ITERATIONS = 6;
// The system prompt asks the model to retry an empty search at most once,
// but that's a soft instruction the model doesn't always honor (observed
// retrying 4+ different search terms in testing). Enforced here instead:
// once this many empty search_products results have occurred in a turn, the
// tool set for the next call is shrunk to just the finishing tool, which
// deterministically forces a finalize since it's the only option left.
const MAX_EMPTY_SEARCH_ATTEMPTS = 2;
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
// selection against an existing context, a single-product detail lookup, or
// none of those) into the one {products, followUp} the customer actually
// sees.
function resolveTurnOutcome({ searchOutcome, showMoreOutcome, discussedProduct, lastProducts, requestedProductIds, state }) {
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

  // Single point where "actually shown to the customer" is recorded — this
  // is the strict grounding set cart mutations require (see
  // isGroundedForMutation in cartTools.js), distinct from and narrower than
  // knownProductIds (which also includes hidden, never-displayed candidates
  // from a search's larger retrieval batch).
  for (const product of outcome.products) {
    if (product && product.id) state.everShownProductIds.add(product.id);
  }

  return outcome;
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
    cart: createEmptyCart(),
  };
  conversations.set(id, state);
  if (conversations.size > MAX_CONVERSATIONS) {
    const oldestKey = conversations.keys().next().value;
    conversations.delete(oldestKey);
  }
  return { id, state };
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
      return "The shopping assistant isn't available right now — please try again later.";
    case "TIMEOUT":
      return "That took a bit too long — please try again.";
    case "QUOTA_EXCEEDED":
      return "The shopping assistant is temporarily busy — please try again in a moment.";
    case "INVALID_API_KEY":
      return "The shopping assistant is misconfigured right now — please try again later.";
    case "MODEL_UNAVAILABLE":
      return "The shopping assistant is temporarily unavailable — please try again later.";
    case "NETWORK_ERROR":
      return "We couldn't reach the shopping assistant — please try again.";
    default:
      return "Something went wrong on our side — please try again.";
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

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const tools =
      emptySearchCount >= MAX_EMPTY_SEARCH_ATTEMPTS
        ? [RESPOND_TOOL]
        : [...TOOL_DEFINITIONS, RESPOND_TOOL, SHOW_MORE_TOOL, ...CART_TOOL_DEFINITIONS, REQUEST_CHECKOUT_TOOL];
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
        followUp: null,
        cart: toCartDTO(state.cart),
      };
    }

    if (result.type === "text") {
      // Defensive fallback only — with tool-calling forced to ANY mode the
      // model should always call respond_to_customer, but a provider can
      // occasionally return plain (even empty) text instead.
      const content = typeof result.content === "string" ? result.content.trim() : "";
      finalText = content !== "" ? content : "Sorry, I didn't quite catch that — could you rephrase?";
      const outcome = resolveTurnOutcome({
        searchOutcome,
        showMoreOutcome,
        discussedProduct,
        lastProducts,
        requestedProductIds,
        state,
      });
      lastProducts = outcome.products;
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
        } else {
          showMoreOutcome = { display: [], followUp: null };
          responses.push({ id: call.id, name: call.name, result: { error: "NO_ACTIVE_SEARCH_CONTEXT" } });
        }
        toolCallLog.push({ name: call.name, outcome: "OK" });
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
        const candidateIds = toolResult.products.map((p) => p.id);
        const isRepeatSingle =
          candidateIds.length === 1 && priorSingleCandidateId !== null && candidateIds[0] === priorSingleCandidateId;

        // A fresh search always starts a brand-new recommendation context —
        // this is what makes a substantially different request (new budget,
        // new category, ...) naturally discard stale candidates rather than
        // needing separate "did the topic change" detection.
        state.searchContext = {
          candidateIds,
          candidates: Object.fromEntries(toolResult.products.map((p) => [p.id, p])),
          shownProductIds: new Set(),
        };
        state.lastSingleCandidateId = candidateIds.length === 1 ? candidateIds[0] : null;
        searchOutcome = { isRepeatSingle };

        if (candidateIds.length === 0) {
          emptySearchCount += 1;
        } else {
          emptySearchCount = 0;
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
      break;
    }

    if (respondArgs) {
      const message = typeof respondArgs.message === "string" ? respondArgs.message.trim() : "";
      finalText = message !== "" ? message : "Sorry, I didn't quite catch that — could you rephrase?";
      requestedProductIds = Array.isArray(respondArgs.productIds) ? respondArgs.productIds : null;
      const outcome = resolveTurnOutcome({
        searchOutcome,
        showMoreOutcome,
        discussedProduct,
        lastProducts,
        requestedProductIds,
        state,
      });
      lastProducts = outcome.products;
      // A successful cart mutation this turn always wins the CTA slot —
      // never fired merely because the model's own text sounds like a cart
      // update; only a real add_to_cart/update_cart_item success sets this.
      finalFollowUp = cartMutationSucceeded ? CHECKOUT_OR_CONTINUE_CTA : outcome.followUp;
      break;
    }
  }

  truncateHistory(state);

  if (finalText === null) {
    finalText = "I'm having trouble completing that right now — could you try rephrasing?";
    finalFollowUp = null;
    lastProducts = [];
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
    followUp: finalFollowUp,
    cart: toCartDTO(state.cart),
  };
}
