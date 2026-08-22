export function isSkuConflictError(error) {
  if (error?.code !== "P2002") return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes("sku") : String(target || "").includes("sku");
}

export function sendSkuConflict(res) {
  return res.status(409).json({
    error: "SKU_ALREADY_EXISTS",
    field: "sku",
    message: "A product with this SKU already exists for this merchant.",
  });
}
