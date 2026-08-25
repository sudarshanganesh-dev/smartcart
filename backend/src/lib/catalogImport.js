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

// Shared per-item pipeline used by EVERY ingestion method (file upload, crawl, and
// any future method): normalize -> validate (lenient — commerce fields optional) ->
// in-batch SKU dedupe -> create -> DB-level SKU-conflict catch -> warning
// classification. Callers never fork this logic; they only supply `items` and a
// `sourceType`.
//
// `items`: Array<{ raw: object, meta?: object, extraWarnings?: string[] }>
//   - `raw` is fed through normalizeRow()/validateProductInput() as-is.
//   - `meta` is caller-supplied identifying/provenance data (e.g. `{ row: 1 }` or
//     `{ url, sourceUrl }`) spread into the corresponding result entry; a
//     `sourceUrl` key in `meta` is also applied to the created Product row.
//   - `extraWarnings` lets a caller layer additional warnings (e.g. an AI-assisted
//     or low-confidence-extraction note) onto the same shared warning output
//     without forking describeWarnings().
export async function importNormalizedRows(items, { merchantId, sourceType }) {
  const seenSkus = new Map(); // sku -> identifying label of the row that first used it
  const results = [];
  let imported = 0;
  let withWarnings = 0;
  let failed = 0;

  for (const item of items) {
    const { raw, meta = {}, extraWarnings = [] } = item;
    const skuLabel = meta.row !== undefined ? `row ${meta.row}` : meta.url || "an earlier item";

    const normalized = normalizeRow(raw);
    const { errors, data } = validateProductInput(normalized, { partial: false, requireCommerceFields: false });

    if (errors.length > 0) {
      failed += 1;
      results.push({ ...meta, outcome: "FAILED", name: normalized.name, errors });
      continue;
    }

    if (data.sku && seenSkus.has(data.sku)) {
      failed += 1;
      results.push({
        ...meta,
        outcome: "FAILED",
        name: data.name,
        errors: [`duplicate SKU "${data.sku}" - already used by ${seenSkus.get(data.sku)}`],
      });
      continue;
    }

    try {
      const product = await prisma.product.create({
        data: {
          ...data,
          merchantId,
          sourceType,
          status: "PENDING_REVIEW",
          ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        },
      });

      if (data.sku) seenSkus.set(data.sku, skuLabel);

      const warnings = [...describeWarnings(data), ...extraWarnings];
      imported += 1;
      if (warnings.length > 0) {
        withWarnings += 1;
        results.push({ ...meta, outcome: "IMPORTED_WITH_WARNINGS", productId: product.id, name: product.name, warnings });
      } else {
        results.push({ ...meta, outcome: "IMPORTED", productId: product.id, name: product.name });
      }
    } catch (error) {
      if (isSkuConflictError(error)) {
        failed += 1;
        results.push({
          ...meta,
          outcome: "FAILED",
          name: data.name,
          errors: ["A product with this SKU already exists for this merchant."],
        });
        continue;
      }
      throw error;
    }
  }

  return { imported, withWarnings, failed, results };
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

  const items = rawRows.map((raw, index) => ({ raw, meta: { row: index + 1 } }));
  const { imported, withWarnings, failed, results } = await importNormalizedRows(items, {
    merchantId,
    sourceType: "FILE_UPLOAD",
  });

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
