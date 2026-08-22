import { prisma } from "./prisma.js";

// Explicit allow-list — a field added to the Product/Merchant models later is
// automatically absent from the commerce DTO unless someone deliberately adds
// it here. Price is serialized as a canonical decimal STRING via Decimal's own
// toFixed(), never converted to a JS Number — money is not represented as a
// floating-point Number anywhere in this layer.
function toProductDTO(product) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    sku: product.sku,
    price: product.price === null ? null : product.price.toFixed(2),
    currency: product.currency,
    category: product.category,
    availability: product.availability,
    stockQuantity: product.stockQuantity,
    merchant: { id: product.merchant.id, name: product.merchant.name },
  };
}

function toMerchantDTO(merchant) {
  return { id: merchant.id, name: merchant.name };
}

function buildProductWhere({ query, merchantId, category, availability, minPrice, maxPrice }) {
  const where = { status: "APPROVED" };

  if (merchantId) where.merchantId = merchantId;
  if (category) where.category = { equals: category, mode: "insensitive" };
  if (availability) where.availability = availability;

  if (minPrice !== undefined || maxPrice !== undefined) {
    where.price = {};
    if (minPrice !== undefined) where.price.gte = minPrice;
    if (maxPrice !== undefined) where.price.lte = maxPrice;
  }

  if (query) {
    where.OR = [
      { name: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
      { category: { contains: query, mode: "insensitive" } },
    ];
  }

  return where;
}

// Deterministic, bounded search over APPROVED products only. `status:
// "APPROVED"` is built into the where clause itself (see buildProductWhere),
// never applied as a post-query filter.
export async function searchProducts({ query, merchantId, category, availability, minPrice, maxPrice, limit = 20, offset = 0 }) {
  const where = buildProductWhere({ query, merchantId, category, availability, minPrice, maxPrice });

  // Fetch one extra row to determine hasMore without a separate COUNT query.
  const rows = await prisma.product.findMany({
    where,
    include: { merchant: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: offset,
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    products: page.map(toProductDTO),
    limit,
    offset,
    hasMore,
  };
}

// Returns null for both "no such product" and "exists but not approved" — the
// caller must translate both to the same 404, never distinguishing them.
export async function getApprovedProductById(productId) {
  const product = await prisma.product.findFirst({
    where: { id: productId, status: "APPROVED" },
    include: { merchant: true },
  });
  return product ? toProductDTO(product) : null;
}

export async function getApprovedProductAvailability(productId) {
  const product = await prisma.product.findFirst({
    where: { id: productId, status: "APPROVED" },
    select: { id: true, availability: true, stockQuantity: true },
  });
  if (!product) return null;
  return { productId: product.id, availability: product.availability, stockQuantity: product.stockQuantity };
}

// Only exposes a merchant that currently has at least one APPROVED product.
// The `some: { status: "APPROVED" }` relational filter makes "doesn't exist"
// and "exists but zero approved products" structurally indistinguishable —
// both simply return no row — rather than relying on two separate checks
// that could drift apart.
export async function getMerchantById(merchantId) {
  const merchant = await prisma.merchant.findFirst({
    where: { id: merchantId, products: { some: { status: "APPROVED" } } },
  });
  return merchant ? toMerchantDTO(merchant) : null;
}
