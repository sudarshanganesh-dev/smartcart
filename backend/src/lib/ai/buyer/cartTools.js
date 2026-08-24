import { getApprovedProductById } from "../../commerceService.js";
import {
  TECHNICAL_MAX_QUANTITY_PER_LINE,
  TECHNICAL_MAX_CART_ITEMS,
  findCartItem,
  releaseLocksIfEmpty,
  toCartDTO,
} from "./cart.js";

// Cart mutation tools — kept in their own file, separate from tools.js's four
// read-only commerce tools, so "read-only, backed by commerceService" stays
// true of tools.js and "mutates the in-memory cart, re-validated against
// commerceService on every call" stays true here. None of these accept
// price, currency, product name, or availability from the model — only
// productId/quantity. Every authoritative fact is re-fetched from
// commerceService before any mutation.
export const CART_TOOL_DEFINITIONS = [
  {
    name: "add_to_cart",
    description:
      "Add a product to the customer's cart, or increase its quantity if it's already there. Only use a productId that was actually shown to the customer in a product card in this conversation.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer", description: "How many to add (default 1)." },
      },
      required: ["productId"],
    },
  },
  {
    name: "view_cart",
    description: "Show the customer's current cart contents and subtotal, re-validated against current commerce data.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "update_cart_item",
    description:
      "Set the quantity of a product already in the customer's cart to an exact value (not a delta). The product must already be in the cart.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer" },
      },
      required: ["productId", "quantity"],
    },
  },
  {
    name: "remove_from_cart",
    description: "Remove a product from the customer's cart entirely.",
    parametersJsonSchema: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
  },
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// A cart mutation may reference a product that was actually shown to this
// customer (the stricter, display-only set — see buyerAgent.js), OR a
// product already sitting in this conversation's cart (so "remove the
// coffee gift box" still works even if it's no longer part of the latest
// recommendation turn). A hidden search candidate that was never displayed,
// and was never added, satisfies neither and is rejected.
function isGroundedForMutation(productId, { everShownProductIds, cart }) {
  return everShownProductIds.has(productId) || Boolean(findCartItem(cart, productId));
}

// Re-fetches truth for one product and classifies why it can't be added or
// have its quantity increased right now, if at all. `requestedTotalQty` is
// the line's quantity AFTER this operation (existing + delta for an add,
// or the new absolute value for an update).
//
// Business/inventory rules are checked FIRST, using commerceService's own
// trusted stockQuantity as the sole authoritative purchasable-quantity
// limit. The technical ceiling (TECHNICAL_MAX_QUANTITY_PER_LINE) is checked
// LAST and only as a last-resort resource/overflow guard — it must never be
// the reason a legitimate, in-stock request is rejected, so a request that
// already fails a real stock rule is never also blamed on the technical one.
async function validateForQuantity(productId, requestedTotalQty) {
  const product = await getApprovedProductById(productId);
  if (!product) {
    return { error: "PRODUCT_UNAVAILABLE", message: "This product is no longer available.", product: null };
  }
  if (product.availability === "UNKNOWN") {
    return {
      error: "AVAILABILITY_UNCONFIRMED",
      message: "I can't add this yet because the merchant hasn't confirmed whether it's currently available.",
      product,
    };
  }
  if (product.availability === "OUT_OF_STOCK") {
    return { error: "OUT_OF_STOCK", message: "This product is currently out of stock.", product };
  }
  if (product.stockQuantity === null) {
    if (requestedTotalQty > 1) {
      return {
        error: "QUANTITY_UNCONFIRMED",
        message:
          "This product is marked in stock, but the exact available quantity isn't known, so I can only safely add one.",
        product,
      };
    }
  } else if (requestedTotalQty > product.stockQuantity) {
    return {
      error: "QUANTITY_EXCEEDS_STOCK",
      message: `Only ${product.stockQuantity} of this item are available.`,
      product,
    };
  }
  if (requestedTotalQty > TECHNICAL_MAX_QUANTITY_PER_LINE) {
    // A pure technical/resource ceiling — must never be phrased as if it
    // were a merchant or inventory limit, since it isn't one.
    return {
      error: "QUANTITY_EXCEEDS_TECHNICAL_LIMIT",
      message: "That quantity is larger than this system currently supports — please try a smaller amount.",
      product,
    };
  }
  return { error: null, product };
}

export const CART_TOOL_EXECUTORS = {
  async add_to_cart(args, context) {
    if (!isNonEmptyString(args.productId)) {
      return { error: "INVALID_ARGUMENTS", message: "productId is required." };
    }
    let quantity = 1;
    if (args.quantity !== undefined) {
      if (!Number.isInteger(args.quantity) || args.quantity < 1) {
        return { error: "INVALID_ARGUMENTS", message: "quantity must be a positive integer." };
      }
      quantity = args.quantity;
    }
    if (!isGroundedForMutation(args.productId, context)) {
      return {
        error: "UNKNOWN_PRODUCT_REFERENCE",
        message: "That product was not part of this conversation's own results.",
      };
    }

    const existing = findCartItem(context.cart, args.productId);
    const requestedTotalQty = (existing ? existing.quantity : 0) + quantity;

    const validation = await validateForQuantity(args.productId, requestedTotalQty);
    if (validation.error) {
      return { error: validation.error, message: validation.message };
    }
    const { product } = validation;

    if (!existing) {
      if (context.cart.items.length >= TECHNICAL_MAX_CART_ITEMS) {
        // A technical cart-capacity bound for this in-memory MVP, not a
        // merchant/business rule — phrased as a system limitation, never as
        // if the merchant or inventory were the reason.
        return {
          error: "CART_CAPACITY_EXCEEDED",
          message: "This cart has reached its maximum number of distinct items for now — please remove something before adding more.",
        };
      }
      if (context.cart.currency !== null && context.cart.currency !== product.currency) {
        return {
          error: "CURRENCY_CONFLICT",
          message: "This cart already contains items priced in a different currency.",
        };
      }
      // Phase 4B: one merchant per cart/order (enforced here, at add-time,
      // so a cross-merchant cart fails fast rather than only at payment) —
      // mirrors the currency lock immediately above.
      if (context.cart.merchantId !== null && context.cart.merchantId !== product.merchant.id) {
        return {
          error: "MERCHANT_CONFLICT",
          message: "This cart already contains items from a different merchant.",
        };
      }
      context.cart.items.push({
        productId: product.id,
        quantity,
        priceSnapshot: product.price,
        name: product.name,
        merchantId: product.merchant.id,
        sku: product.sku,
      });
      context.cart.currency = product.currency;
      context.cart.merchantId = product.merchant.id;
    } else {
      existing.quantity = requestedTotalQty;
      existing.priceSnapshot = product.price;
      existing.name = product.name;
      existing.merchantId = product.merchant.id;
      existing.sku = product.sku;
    }

    return { ok: true, cart: toCartDTO(context.cart) };
  },

  async update_cart_item(args, context) {
    if (!isNonEmptyString(args.productId)) {
      return { error: "INVALID_ARGUMENTS", message: "productId is required." };
    }
    if (!Number.isInteger(args.quantity) || args.quantity < 1) {
      return { error: "INVALID_ARGUMENTS", message: "quantity must be a positive integer." };
    }
    if (!isGroundedForMutation(args.productId, context)) {
      return {
        error: "UNKNOWN_PRODUCT_REFERENCE",
        message: "That product was not part of this conversation's own results.",
      };
    }

    const existing = findCartItem(context.cart, args.productId);
    if (!existing) {
      return { error: "ITEM_NOT_IN_CART", message: "That item isn't currently in your cart." };
    }

    const validation = await validateForQuantity(args.productId, args.quantity);
    if (validation.error === "PRODUCT_UNAVAILABLE") {
      // Stale item discovered mid-update — drop it rather than leaving a
      // ghost line the customer can no longer act on.
      context.cart.items = context.cart.items.filter((item) => item.productId !== args.productId);
      releaseLocksIfEmpty(context.cart);
      return { error: "PRODUCT_UNAVAILABLE", message: "This item is no longer available and was removed from your cart." };
    }
    if (validation.error) {
      return { error: validation.error, message: validation.message };
    }

    existing.quantity = args.quantity;
    existing.priceSnapshot = validation.product.price;
    existing.name = validation.product.name;
    existing.merchantId = validation.product.merchant.id;
    existing.sku = validation.product.sku;

    return { ok: true, cart: toCartDTO(context.cart) };
  },

  async remove_from_cart(args, context) {
    if (!isNonEmptyString(args.productId)) {
      return { error: "INVALID_ARGUMENTS", message: "productId is required." };
    }
    if (!isGroundedForMutation(args.productId, context)) {
      return {
        error: "UNKNOWN_PRODUCT_REFERENCE",
        message: "That product was not part of this conversation's own results.",
      };
    }

    const existing = findCartItem(context.cart, args.productId);
    if (!existing) {
      return { error: "ITEM_NOT_IN_CART", message: "That item isn't currently in your cart." };
    }

    context.cart.items = context.cart.items.filter((item) => item.productId !== args.productId);
    releaseLocksIfEmpty(context.cart);

    return { ok: true, cart: toCartDTO(context.cart) };
  },

  // Re-validates every line against current commerce truth: drops
  // deleted/pending/rejected lines (reporting them), refreshes price
  // snapshots (reporting any change), and leaves OUT_OF_STOCK/UNKNOWN lines
  // in place but marked `blocked` rather than silently removing something
  // the customer deliberately added.
  async view_cart(args, context) {
    return revalidateCart(context.cart);
  },
};

// The checkout-readiness message is entirely backend-authored, not
// Gemini-paraphrased — this is the one place a wrong word ("your order is
// placed") would be a real safety problem, so it's a fixed template rather
// than free text the model composes. Phase 3C never creates any
// payment/order/Razorpay object here — this only ever reports readiness.
export async function resolveCheckoutOutcome(cart) {
  const { cart: cartDTO, removed, blockedByProductId, priceChanges } = await revalidateCart(cart);

  if (cartDTO.items.length === 0) {
    const removedNote =
      removed.length > 0
        ? ` ${removed.map((r) => r.name).join(", ")} ${removed.length === 1 ? "was" : "were"} removed because it's no longer available.`
        : "";
    return { ready: false, message: `Your cart is empty — there's nothing to check out yet.${removedNote}`, cart: cartDTO };
  }

  const blockedNames = cartDTO.items.filter((item) => item.blocked).map((item) => item.name);
  if (blockedNames.length > 0) {
    return {
      ready: false,
      message: `Your cart isn't ready for checkout yet — ${blockedNames.join(", ")} ${blockedNames.length === 1 ? "is" : "are"} no longer available. Please remove ${blockedNames.length === 1 ? "it" : "them"}, or wait until it's back, before checking out.`,
      cart: cartDTO,
    };
  }

  const priceNote =
    priceChanges.length > 0
      ? ` Note: the price of ${priceChanges.map((p) => `${p.name} (${p.oldPrice} → ${p.newPrice})`).join(", ")} changed since you added it — the subtotal below already reflects the current price.`
      : "";
  const removedNote =
    removed.length > 0
      ? ` ${removed.map((r) => r.name).join(", ")} ${removed.length === 1 ? "was" : "were"} removed from your cart because it's no longer available.`
      : "";

  return {
    ready: true,
    message: `Your cart is ready for checkout — ${cartDTO.itemCount} item${cartDTO.itemCount === 1 ? "" : "s"}, subtotal ${cartDTO.currency} ${cartDTO.subtotal}. Payment has not been started yet.${priceNote}${removedNote}`,
    cart: cartDTO,
  };
}

export async function revalidateCart(cart) {
  const removed = [];
  const priceChanges = [];
  const blockedByProductId = {};

  for (const item of [...cart.items]) {
    const product = await getApprovedProductById(item.productId);
    if (!product) {
      cart.items = cart.items.filter((i) => i.productId !== item.productId);
      removed.push({ productId: item.productId, name: item.name });
      continue;
    }
    if (product.price !== item.priceSnapshot) {
      priceChanges.push({ productId: item.productId, name: item.name, oldPrice: item.priceSnapshot, newPrice: product.price });
      item.priceSnapshot = product.price;
    }
    item.name = product.name;
    item.merchantId = product.merchant.id;
    item.sku = product.sku;
    if (product.availability !== "IN_STOCK") {
      blockedByProductId[item.productId] = product.availability === "OUT_OF_STOCK" ? "OUT_OF_STOCK" : "AVAILABILITY_UNCONFIRMED";
    }
  }
  releaseLocksIfEmpty(cart);

  return { cart: toCartDTO(cart, blockedByProductId), removed, priceChanges, blockedByProductId };
}

// Payment-specific revalidation (Phase 4A): everything revalidateCart above
// already does, PLUS an explicit re-check that each surviving item's
// quantity is still supported by CURRENT trusted stock. revalidateCart is
// intentionally lighter (used by the read-only view_cart/request_checkout,
// unchanged here) — a real payment must never proceed on a quantity that's
// no longer available, even if availability itself is still IN_STOCK.
export async function validateCartForCheckout(cart) {
  const base = await revalidateCart(cart);
  const insufficientStock = [];

  for (const item of cart.items) {
    if (base.blockedByProductId[item.productId]) continue; // already OUT_OF_STOCK/UNKNOWN, reported separately

    const product = await getApprovedProductById(item.productId);
    if (!product) continue; // already removed above

    if (product.stockQuantity === null) {
      if (item.quantity > 1) {
        insufficientStock.push({ productId: item.productId, name: item.name, requestedQuantity: item.quantity, availableQuantity: null });
      }
    } else if (item.quantity > product.stockQuantity) {
      insufficientStock.push({
        productId: item.productId,
        name: item.name,
        requestedQuantity: item.quantity,
        availableQuantity: product.stockQuantity,
      });
    }
  }

  return { ...base, insufficientStock };
}
