// Display-only formatting — the backend/database/payment system keeps using
// "INR" as the currency code everywhere; this only changes how a decimal
// string is shown to a user. Never used for calculation, only rendering.
export function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '-'
  const number = Number(value)
  if (Number.isNaN(number)) return String(value)
  return `₹${number.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
