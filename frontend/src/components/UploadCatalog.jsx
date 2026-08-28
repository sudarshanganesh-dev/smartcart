import { useState } from 'react'
import { Download } from 'lucide-react'
import { importCatalog, ApiError } from '../lib/api.js'

const FORMAT_OPTIONS = [
  { key: 'csv', label: 'CSV', accept: '.csv,text/csv' },
  { key: 'json', label: 'JSON', accept: '.json,application/json' },
]

// Mirrors catalogImport.js's CANONICAL_FIELDS exactly (backend/src/lib/catalogImport.js) —
// display labels only, never re-validated here. The importer itself only
// unconditionally requires "Name" (see productValidation.js,
// requireCommerceFields: false) and deliberately allows an incomplete row
// into Pending Review to be completed later via the product edit form.
// Price/Currency/Category are grouped as "recommended" (not "required")
// because that's what a merchant needs for a genuinely complete, buyer-ready
// listing — Price/Currency are enforced at approval time
// (getApprovalRequirementFailures), but Category is not a hard gate anywhere
// in the backend, so it must never be labeled as required.
const CSV_RECOMMENDED_FIELDS = ['Name', 'Price', 'Currency', 'Category']
const CSV_OPTIONAL_FIELDS = ['Description', 'SKU', 'Availability', 'Stock Quantity']
// Matches productValidation.js's AVAILABILITY_VALUES exactly.
const AVAILABILITY_VALUES = ['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']

const CSV_TEMPLATE_FILENAME = 'smartcart-catalog-template.csv'
// One realistic example row, using the exact header names catalogImport.js's
// CANONICAL_LOOKUP recognizes (headers are matched case-insensitively, but the
// template uses the canonical casing). Generated and downloaded entirely in
// the browser — no backend call, no database write.
const CSV_TEMPLATE_CONTENT =
  'Name,Description,Price,Currency,Category,SKU,Availability,StockQuantity\n' +
  'Chocolate Cupcake Box,Box of chocolate cupcakes,349.00,INR,Cupcakes,CUPCAKE-001,IN_STOCK,12\n'

// Real object -> JSON.stringify at render time, so the displayed example can
// never silently drift from valid JSON. Keys match catalogImport.js's
// normalizeRow() exactly (parseJson() does no header remapping, unlike CSV —
// JSON keys are read by this exact camelCase name).
const JSON_EXAMPLE = [
  {
    name: 'Chocolate Cupcake Box',
    description: 'Box of chocolate cupcakes',
    price: 349,
    currency: 'INR',
    category: 'Cupcakes',
    sku: 'CUPCAKE-001',
    availability: 'IN_STOCK',
    stockQuantity: 12,
  },
]

function downloadCsvTemplate() {
  const blob = new Blob([CSV_TEMPLATE_CONTENT], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = CSV_TEMPLATE_FILENAME
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function FormatGuide({ format }) {
  if (format === 'csv') {
    return (
      <div className="upload-format-guide">
        <p className="upload-format-guide__title">CSV format</p>

        <div className="upload-format-guide__row">
          <span className="upload-format-guide__row-label">Recommended for a complete product</span>
          <div className="upload-format-guide__fields">
            {CSV_RECOMMENDED_FIELDS.map((field) => (
              <span key={field} className="upload-format-guide__field upload-format-guide__field--required">
                {field}
              </span>
            ))}
          </div>
        </div>

        <div className="upload-format-guide__row">
          <span className="upload-format-guide__row-label">Optional</span>
          <div className="upload-format-guide__fields">
            {CSV_OPTIONAL_FIELDS.map((field) => (
              <span key={field} className="upload-format-guide__field">
                {field}
              </span>
            ))}
          </div>
        </div>

        <p className="field-hint">
          Availability: {AVAILABILITY_VALUES.join(' · ')}. Currency: a 3-letter code, e.g. INR.
        </p>

        <button type="button" className="upload-format-guide__download" onClick={downloadCsvTemplate}>
          <Download size={14} strokeWidth={2.25} aria-hidden="true" />
          Download CSV template
        </button>
      </div>
    )
  }

  return (
    <div className="upload-format-guide">
      <p className="upload-format-guide__title">JSON format</p>
      <p className="field-hint">A JSON array of products, each with these fields:</p>

      <div className="upload-format-guide__row">
        <span className="upload-format-guide__row-label">Recommended for a complete product</span>
        <div className="upload-format-guide__fields">
          {['name', 'price', 'currency', 'category'].map((field) => (
            <span key={field} className="upload-format-guide__field upload-format-guide__field--required">
              {field}
            </span>
          ))}
        </div>
      </div>

      <div className="upload-format-guide__row">
        <span className="upload-format-guide__row-label">Optional</span>
        <div className="upload-format-guide__fields">
          {['description', 'sku', 'availability', 'stockQuantity'].map((field) => (
            <span key={field} className="upload-format-guide__field">
              {field}
            </span>
          ))}
        </div>
      </div>

      <pre className="upload-format-guide__code">{JSON.stringify(JSON_EXAMPLE, null, 2)}</pre>
    </div>
  )
}

function describeBatchError(error) {
  if (error instanceof ApiError && error.body?.error) {
    switch (error.body.error) {
      case 'FILE_REQUIRED':
        return 'Please choose a file to upload.'
      case 'INVALID_FORMAT':
        return 'Please choose CSV or JSON before uploading.'
      case 'FILE_TOO_LARGE':
        return `File is too large. Maximum size is ${Math.round(error.body.maxBytes / (1024 * 1024))} MB.`
      case 'PARSE_FAILED':
        return `Could not read the file: ${error.body.message || 'invalid format.'}`
      case 'EMPTY_FILE':
        return 'The file has no rows to import.'
      case 'TOO_MANY_ROWS':
        return `The file has too many rows. Maximum is ${error.body.max}.`
      default:
        return error.message
    }
  }
  return 'Something went wrong. Please try again.'
}

function outcomeBadgeClass(outcome) {
  if (outcome === 'FAILED') return 'outcome-badge outcome-badge--failed'
  if (outcome === 'IMPORTED_WITH_WARNINGS') return 'outcome-badge outcome-badge--warning'
  return 'outcome-badge outcome-badge--imported'
}

function UploadCatalog({ merchant, onBack, onDone }) {
  const [format, setFormat] = useState(null)
  const [file, setFile] = useState(null)
  const [stage, setStage] = useState('choose-format') // choose-format | ready | processing | summary
  const [summary, setSummary] = useState(null)
  const [batchError, setBatchError] = useState(null)

  function selectFormat(key) {
    setFormat(key)
    setFile(null)
    setBatchError(null)
    setStage('ready')
  }

  function reset() {
    setFormat(null)
    setFile(null)
    setSummary(null)
    setBatchError(null)
    setStage('choose-format')
  }

  async function handleUpload() {
    if (!file) return
    setStage('processing')
    setBatchError(null)
    try {
      const result = await importCatalog(merchant.id, format, file)
      setSummary(result)
      setStage('summary')
    } catch (error) {
      setBatchError(describeBatchError(error))
      setStage('ready')
    }
  }

  const activeFormat = FORMAT_OPTIONS.find((option) => option.key === format)

  return (
    <div className="upload-catalog">
      <div className="product-workspace__header">
        <button type="button" className="link-button" onClick={onBack}>
          ← Back
        </button>
        <h2>{merchant.name} - Upload Catalog</h2>
      </div>

      {stage === 'choose-format' && (
        <div className="upload-format-choice">
          <p>Choose the file format you want to upload.</p>
          <div className="ingestion-choices">
            {FORMAT_OPTIONS.map((option) => (
              <div className="ingestion-card" key={option.key}>
                <h3>{option.label}</h3>
                <button type="button" onClick={() => selectFormat(option.key)}>
                  Choose {option.label}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(stage === 'ready' || stage === 'processing') && activeFormat && (
        <div className="upload-file-picker">
          <p>
            Format: <strong>{activeFormat.label}</strong>{' '}
            <button type="button" className="link-button" onClick={reset} disabled={stage === 'processing'}>
              change
            </button>
          </p>

          <FormatGuide format={format} />

          {batchError && (
            <div className="error-banner">
              <p>{batchError}</p>
            </div>
          )}

          <input
            type="file"
            aria-label="Catalog file"
            accept={activeFormat.accept}
            disabled={stage === 'processing'}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />

          <div className="product-form__actions">
            <button type="button" onClick={handleUpload} disabled={!file || stage === 'processing'}>
              {stage === 'processing' ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>
      )}

      {stage === 'summary' && summary && (
        <div className="upload-summary">
          <div className="upload-summary__counts">
            <div className="upload-summary__stat">
              <span className="upload-summary__number">{summary.totalRows}</span>
              <span>Total rows</span>
            </div>
            <div className="upload-summary__stat">
              <span className="upload-summary__number">{summary.imported}</span>
              <span>Imported</span>
            </div>
            <div className="upload-summary__stat">
              <span className="upload-summary__number">{summary.withWarnings}</span>
              <span>With warnings</span>
            </div>
            <div className="upload-summary__stat">
              <span className="upload-summary__number">{summary.failed}</span>
              <span>Failed</span>
            </div>
          </div>

          {summary.ignoredColumns?.length > 0 && (
            <p className="upload-summary__ignored">Ignored columns: {summary.ignoredColumns.join(', ')}</p>
          )}

          <ul className="upload-row-list">
            {summary.rows.map((row) => (
              <li key={row.row} className="upload-row">
                <span className="upload-row__row">Row {row.row}</span>
                <span className="upload-row__name">{row.name || '(no name)'}</span>
                <span className={outcomeBadgeClass(row.outcome)}>{row.outcome.replace(/_/g, ' ')}</span>
                {row.errors && <p className="product-row__error">{row.errors.join('; ')}</p>}
                {row.warnings && <p className="field-hint">{row.warnings.join('; ')}</p>}
              </li>
            ))}
          </ul>

          <div className="product-form__actions">
            <button type="button" onClick={onDone}>
              Go to Pending Review
            </button>
            <button type="button" onClick={reset}>
              Upload another file
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default UploadCatalog
