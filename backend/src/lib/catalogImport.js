import { parse as parseCsvSync } from "csv-parse/sync";
import { prisma } from "./prisma.js";
import { validateProductInput } from "./productValidation.js";
import { isSkuConflictError } from "./prismaErrors.js";

export const MAX_IMPORT_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_IMPORT_ROWS = 500;

const CANONICAL_FIELDS = ["name", "description", "price", "currency", "category", "sku", "availability", "stockQuantity"];
const CANONICAL_LOOKUP = new Map(CANONICAL_FIELDS.map((field) => [field.toLowerCase(), field]));

const DELIMITER_CANDIDATES = [",", ";", "\t"];

// Excel writes "CSV" using the OS list-separator, which is a semicolon (or tab)
// on many non-US locales even though the file is still comma-shaped English text
// to the user. Hardcoding a comma silently collapses the whole header row into a
// single unmatched column. Sniff the header line for whichever candidate actually
// splits it, falling back to comma for the common case.
function detectDelimiter(text) {
  const headerLine = text.split(/\r\n|\r|\n/, 1)[0] || "";
  let best = ",";
  let bestCount = 0;
  for (const candidate of DELIMITER_CANDIDATES) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

function parseCsv(buffer) {
  const text = buffer.toString("utf8");
  const records = parseCsvSync(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter: detectDelimiter(text),
  });

  if (records.length === 0) {
    return { rows: [], ignoredColumns: [] };
  }

  const originalHeaders = Object.keys(records[0]);
  const headerMap = {};
  const ignoredColumns = [];

  for (const header of originalHeaders) {
    const canonical = CANONICAL_LOOKUP.get(header.trim().toLowerCase());
    headerMap[header] = canonical || null;
    if (!canonical) ignoredColumns.push(header);
  }

  const rows = records.map((record) => {
    const row = {};
    for (const [header, value] of Object.entries(record)) {
      const canonical = headerMap[header];
      if (canonical) row[canonical] = value;
    }
    return row;
  });

  return { rows, ignoredColumns };
}

function parseJson(buffer) {
  const text = buffer.toString("utf8");
  const data = JSON.parse(text);

  let rows;
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && Array.isArray(data.products)) {
    rows = data.products;
  } else {
    throw new Error('Expected a JSON array of products, or an object with a "products" array.');
  }

  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Row ${index + 1} is not a JSON object.`);
    }
  });

  return { rows, ignoredColumns: [] };
}

function normalizeField(value) {
  if (value === undefined || value === null) return { present: false };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return { present: false };
    return { present: true, value: trimmed };
  }
  return { present: true, value };
}

// Shared normalization for both CSV and JSON rows: coerces whatever raw value
// arrived (always a string from CSV, a native type from JSON) into the shape
// validateProductInput() expects, treating blank/absent as "not provided"
// rather than a literal empty string.
function normalizeRow(rawRow) {
  const row = {};

  const name = normalizeField(rawRow.name);
  if (name.present) row.name = name.value;

  const description = normalizeField(rawRow.description);
  if (description.present) row.description = description.value;

  const sku = normalizeField(rawRow.sku);
  if (sku.present) row.sku = sku.value;

  const category = normalizeField(rawRow.category);
  if (category.present) row.category = category.value;

  const price = normalizeField(rawRow.price);
  if (price.present) {
    row.price = typeof price.value === "number" ? price.value : Number(price.value);
  }

  const currency = normalizeField(rawRow.currency);
  if (currency.present) {
    row.currency = String(currency.value).toUpperCase();
  }

  const availability = normalizeField(rawRow.availability);
  if (availability.present) {
    row.availability = String(availability.value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  }

  const stockQuantity = normalizeField(rawRow.stockQuantity);
  if (stockQuantity.present) {
    row.stockQuantity = typeof stockQuantity.value === "number" ? stockQuantity.value : Number(stockQuantity.value);
  }

  return row;
}

function describeWarnings(data) {
  const warnings = [];
  if (data.price === undefined || data.price === null) warnings.push("price missing");
  if (data.currency === undefined || data.currency === null) warnings.push("currency missing");
  if (data.category === undefined || data.category === null) warnings.push("category missing");
  const availability = data.availability !== undefined ? data.availability : "UNKNOWN";
  if (availability === "UNKNOWN") warnings.push("availability is UNKNOWN");
  return warnings;
}

export async function importCatalogFile({ buffer, format, merchantId }) {
  let parsed;
  try {
    if (format === "csv") {
      parsed = parseCsv(buffer);
    } else if (format === "json") {
      parsed = parseJson(buffer);
    } else {
      return { batchError: { error: "INVALID_FORMAT" } };
    }
  } catch (error) {
    return { batchError: { error: "PARSE_FAILED", message: error.message } };
  }

  const { rows: rawRows, ignoredColumns } = parsed;

  if (rawRows.length === 0) {
    return { batchError: { error: "EMPTY_FILE" } };
  }

  if (rawRows.length > MAX_IMPORT_ROWS) {
    return { batchError: { error: "TOO_MANY_ROWS", max: MAX_IMPORT_ROWS } };
  }

  const seenSkus = new Map(); // sku -> row number that first used it
  const results = [];
  let imported = 0;
  let withWarnings = 0;
  let failed = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 1;
    const normalized = normalizeRow(rawRows[i]);

    const { errors, data } = validateProductInput(normalized, { partial: false, requireCommerceFields: false });

    if (errors.length > 0) {
      failed += 1;
      results.push({ row: rowNumber, outcome: "FAILED", name: normalized.name, errors });
      continue;
    }

    if (data.sku && seenSkus.has(data.sku)) {
      failed += 1;
      results.push({
        row: rowNumber,
        outcome: "FAILED",
        name: data.name,
        errors: [`duplicate SKU "${data.sku}" — already used by row ${seenSkus.get(data.sku)}`],
      });
      continue;
    }

    try {
      const product = await prisma.product.create({
        data: {
          ...data,
          merchantId,
          sourceType: "FILE_UPLOAD",
          status: "PENDING_REVIEW",
        },
      });

      if (data.sku) seenSkus.set(data.sku, rowNumber);

      const warnings = describeWarnings(data);
      imported += 1;
      if (warnings.length > 0) {
        withWarnings += 1;
        results.push({ row: rowNumber, outcome: "IMPORTED_WITH_WARNINGS", productId: product.id, name: product.name, warnings });
      } else {
        results.push({ row: rowNumber, outcome: "IMPORTED", productId: product.id, name: product.name });
      }
    } catch (error) {
      if (isSkuConflictError(error)) {
        failed += 1;
        results.push({
          row: rowNumber,
          outcome: "FAILED",
          name: data.name,
          errors: ["A product with this SKU already exists for this merchant."],
        });
        continue;
      }
      throw error;
    }
  }

  return {
    summary: {
      totalRows: rawRows.length,
      imported,
      withWarnings,
      failed,
      ignoredColumns,
      rows: results,
    },
  };
}
