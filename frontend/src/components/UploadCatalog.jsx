import { useState } from 'react'
import { importCatalog, ApiError } from '../lib/api.js'

const FORMAT_OPTIONS = [
  { key: 'csv', label: 'CSV', accept: '.csv,text/csv' },
  { key: 'json', label: 'JSON', accept: '.json,application/json' },
]

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
        <h2>{merchant.name} — Upload Catalog</h2>
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

          {batchError && (
            <div className="error-banner">
              <p>{batchError}</p>
            </div>
          )}

          <input
            type="file"
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
