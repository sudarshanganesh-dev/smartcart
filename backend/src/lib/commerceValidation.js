import { Prisma } from "@prisma/client";

export const AVAILABILITY_VALUES = ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"];

// Matches the Product.price column's own precision/scale (Decimal(10,2): up to
// 8 integer digits, up to 2 fractional digits) — not an arbitrary regex.
const DECIMAL_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

export function isValidAvailability(value) {
  return AVAILABILITY_VALUES.includes(value);
}

// Parses minPrice/maxPrice query params into Prisma-compatible Decimal values.
// Deliberately never routes a money value through parseFloat/Number: format
// is checked with a regex tied to the column's own precision, and the value
// is parsed/compared using Prisma's own Decimal type end to end, so canonical
// money never touches floating-point arithmetic at any point.
export function parsePriceRange(minPriceRaw, maxPriceRaw) {
  let minPrice;
  let maxPrice;

  if (minPriceRaw !== undefined) {
    if (typeof minPriceRaw !== "string" || !DECIMAL_PATTERN.test(minPriceRaw)) {
      return { error: true };
    }
    minPrice = new Prisma.Decimal(minPriceRaw);
  }

  if (maxPriceRaw !== undefined) {
    if (typeof maxPriceRaw !== "string" || !DECIMAL_PATTERN.test(maxPriceRaw)) {
      return { error: true };
    }
    maxPrice = new Prisma.Decimal(maxPriceRaw);
  }

  if (minPrice !== undefined && maxPrice !== undefined && minPrice.greaterThan(maxPrice)) {
    return { error: true };
  }

  return { error: false, minPrice, maxPrice };
}

// limit/offset are plain pagination indices, not money — ordinary integer
// parsing is fine here; the money-representation restriction is scoped to
// price/currency values only.
export function parsePagination(limitRaw, offsetRaw, { defaultLimit = 20, maxLimit = 50 } = {}) {
  let limit = defaultLimit;
  let offset = 0;

  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "string" || !/^\d+$/.test(limitRaw)) return { error: true };
    const parsed = Number(limitRaw);
    if (parsed < 1 || parsed > maxLimit) return { error: true };
    limit = parsed;
  }

  if (offsetRaw !== undefined) {
    if (typeof offsetRaw !== "string" || !/^\d+$/.test(offsetRaw)) return { error: true };
    offset = Number(offsetRaw);
  }

  return { error: false, limit, offset };
}
