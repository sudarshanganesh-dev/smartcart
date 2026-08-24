const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AVAILABILITY_VALUES = ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"];

// Phase 6 hardening: explicit string-length ceilings, generous enough for any
// legitimate product listing. Prevents a merchant-input string from growing
// unboundedly before it reaches the database.
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_SKU_LENGTH = 100;
const MAX_CATEGORY_LENGTH = 100;

// Must fit the schema's Product.price column, Decimal(10,2): 8 integer
// digits + 2 decimal digits.
const MAX_PRICE = 99999999.99;

export const EDITABLE_FIELDS = [
  "name",
  "description",
  "sku",
  "category",
  "price",
  "currency",
  "availability",
  "stockQuantity",
];

export const COMMERCE_CRITICAL_FIELDS = [
  "name",
  "price",
  "currency",
  "availability",
  "stockQuantity",
  "sku",
];

export function validateProductInput(body, { partial = false, requireCommerceFields = false } = {}) {
  const errors = [];
  const data = {};

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (!partial || has("name")) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      errors.push("name must be a non-empty string");
    } else if (body.name.trim().length > MAX_NAME_LENGTH) {
      errors.push(`name must be at most ${MAX_NAME_LENGTH} characters`);
    } else {
      data.name = body.name.trim();
    }
  }

  if (has("description")) {
    if (body.description !== null && typeof body.description !== "string") {
      errors.push("description must be a string or null");
    } else if (typeof body.description === "string" && body.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
    } else {
      data.description = body.description;
    }
  }

  if (has("sku")) {
    if (body.sku !== null && typeof body.sku !== "string") {
      errors.push("sku must be a string or null");
    } else if (typeof body.sku === "string" && body.sku.length > MAX_SKU_LENGTH) {
      errors.push(`sku must be at most ${MAX_SKU_LENGTH} characters`);
    } else {
      data.sku = body.sku;
    }
  }

  if (has("category")) {
    if (body.category !== null && typeof body.category !== "string") {
      errors.push("category must be a string or null");
    } else if (requireCommerceFields && (body.category === null || body.category.trim().length === 0)) {
      errors.push("category is required");
    } else if (typeof body.category === "string" && body.category.length > MAX_CATEGORY_LENGTH) {
      errors.push(`category must be at most ${MAX_CATEGORY_LENGTH} characters`);
    } else {
      data.category = body.category;
    }
  } else if (requireCommerceFields) {
    errors.push("category is required");
  }

  if (has("price")) {
    if (body.price !== null && (typeof body.price !== "number" || Number.isNaN(body.price) || body.price < 0)) {
      errors.push("price must be a non-negative number or null");
    } else if (body.price !== null && body.price > MAX_PRICE) {
      errors.push(`price must be at most ${MAX_PRICE}`);
    } else if (requireCommerceFields && body.price === null) {
      errors.push("price is required");
    } else {
      data.price = body.price;
    }
  } else if (requireCommerceFields) {
    errors.push("price is required");
  }

  if (has("currency")) {
    if (body.currency !== null && !CURRENCY_PATTERN.test(body.currency)) {
      errors.push("currency must be a 3-letter uppercase ISO 4217 code or null");
    } else if (requireCommerceFields && body.currency === null) {
      errors.push("currency is required");
    } else {
      data.currency = body.currency;
    }
  } else if (requireCommerceFields) {
    errors.push("currency is required");
  }

  if (has("availability")) {
    if (!AVAILABILITY_VALUES.includes(body.availability)) {
      errors.push(`availability must be one of ${AVAILABILITY_VALUES.join(", ")}`);
    } else {
      data.availability = body.availability;
    }
  } else if (requireCommerceFields) {
    errors.push("availability is required");
  }

  if (has("stockQuantity")) {
    if (
      body.stockQuantity !== null &&
      (typeof body.stockQuantity !== "number" || !Number.isInteger(body.stockQuantity) || body.stockQuantity < 0)
    ) {
      errors.push("stockQuantity must be a non-negative integer or null");
    } else {
      data.stockQuantity = body.stockQuantity;
    }
  }

  if (has("sourceUrl")) {
    if (body.sourceUrl !== null && typeof body.sourceUrl !== "string") {
      errors.push("sourceUrl must be a string or null");
    } else {
      data.sourceUrl = body.sourceUrl;
    }
  }

  return { errors, data };
}

export function getApprovalRequirementFailures(product) {
  const missing = [];

  if (!product.name || product.name.trim().length === 0) {
    missing.push("name");
  }

  if (product.price === null || product.price === undefined || Number(product.price) < 0) {
    missing.push("price");
  }

  if (!product.currency || !CURRENCY_PATTERN.test(product.currency)) {
    missing.push("currency");
  }

  return missing;
}
