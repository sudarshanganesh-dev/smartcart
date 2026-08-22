const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AVAILABILITY_VALUES = ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"];

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

export function validateProductInput(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (!partial || has("name")) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      errors.push("name must be a non-empty string");
    } else {
      data.name = body.name.trim();
    }
  }

  if (has("description")) {
    if (body.description !== null && typeof body.description !== "string") {
      errors.push("description must be a string or null");
    } else {
      data.description = body.description;
    }
  }

  if (has("sku")) {
    if (body.sku !== null && typeof body.sku !== "string") {
      errors.push("sku must be a string or null");
    } else {
      data.sku = body.sku;
    }
  }

  if (has("category")) {
    if (body.category !== null && typeof body.category !== "string") {
      errors.push("category must be a string or null");
    } else {
      data.category = body.category;
    }
  }

  if (has("price")) {
    if (body.price !== null && (typeof body.price !== "number" || Number.isNaN(body.price) || body.price < 0)) {
      errors.push("price must be a non-negative number or null");
    } else {
      data.price = body.price;
    }
  }

  if (has("currency")) {
    if (body.currency !== null && !CURRENCY_PATTERN.test(body.currency)) {
      errors.push("currency must be a 3-letter uppercase ISO 4217 code or null");
    } else {
      data.currency = body.currency;
    }
  }

  if (has("availability")) {
    if (!AVAILABILITY_VALUES.includes(body.availability)) {
      errors.push(`availability must be one of ${AVAILABILITY_VALUES.join(", ")}`);
    } else {
      data.availability = body.availability;
    }
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
