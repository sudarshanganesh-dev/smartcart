// Pure cart domain logic — no I/O, no commerceService import. Cart truth
// (price/currency/availability/stock) always comes from commerceService via
// cartTools.js; this file only knows how to represent and total up whatever
// it's given. Kept dependency-free so it's trivially unit-testable.

// Pure technical/resource-protection ceilings for this in-memory MVP — NOT
// business or inventory rules. The real purchasable-quantity limit is always
// commerceService's stockQuantity (see cartTools.js's validateForQuantity);
// these two numbers exist only to bound worst-case memory/arithmetic size
// and are set high enough that no legitimate purchase should ever reach
// them. A customer-facing message must never cite these as if they were a
// merchant/stock limit.
export const TECHNICAL_MAX_QUANTITY_PER_LINE = 1000;
export const TECHNICAL_MAX_CART_ITEMS = 50;

export function createEmptyCart() {
  return { currency: null, items: [] };
}

// Money is never handled as a JS float. A validated "123.45"-style decimal
// string (commerceService always emits exactly 2 decimal places via
// Decimal.toFixed(2)) is converted to an integer count of minor units,
// summed/multiplied as plain integers, and converted back only at the edge.
export function toMinorUnits(decimalString) {
  const [whole, frac = ""] = decimalString.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function fromMinorUnits(minorUnits) {
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function findCartItem(cart, productId) {
  return cart.items.find((item) => item.productId === productId) || null;
}

export function lineTotal(item) {
  return fromMinorUnits(toMinorUnits(item.priceSnapshot) * item.quantity);
}

export function subtotal(cart) {
  const totalMinorUnits = cart.items.reduce((sum, item) => sum + toMinorUnits(item.priceSnapshot) * item.quantity, 0);
  return fromMinorUnits(totalMinorUnits);
}

export function totalUnitCount(cart) {
  return cart.items.reduce((sum, item) => sum + item.quantity, 0);
}

// If removing an item empties the cart, the currency lock is released so a
// different currency can be started fresh next time.
export function releaseCurrencyLockIfEmpty(cart) {
  if (cart.items.length === 0) {
    cart.currency = null;
  }
}

// The exact customer-facing shape from the approved Phase 3C spec, plus one
// additive, non-breaking `blocked`/`blockReason` pair per item so a stale
// OUT_OF_STOCK/UNKNOWN item stays visible (never silently dropped) while
// still being clearly marked as blocking checkout. No internal
// snapshot/history fields are exposed — `priceSnapshot` never appears
// verbatim; it's surfaced only as `unitPrice`.
export function toCartDTO(cart, blockedByProductId = {}) {
  return {
    currency: cart.currency,
    itemCount: totalUnitCount(cart),
    subtotal: subtotal(cart),
    items: cart.items.map((item) => {
      const blockReason = blockedByProductId[item.productId];
      return {
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.priceSnapshot,
        lineTotal: lineTotal(item),
        blocked: Boolean(blockReason),
        ...(blockReason ? { blockReason } : {}),
      };
    }),
  };
}
