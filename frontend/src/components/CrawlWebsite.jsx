import { useState } from 'react'
import { crawlWebsite, ApiError } from '../lib/api.js'

const COMPATIBILITY_COPY = {
  COMPATIBLE: {
    heading: 'Website compatible',
    message: 'We found and imported product data from your website. Review the products before approving them.',
  },
  PARTIALLY_COMPATIBLE: {
    heading: 'Website partially compatible',
    message: 'We found products, but some information could not be extracted reliably. Review the highlighted products before approving them.',
  },
}

const UNAVAILABLE_REASON_MESSAGES = {
  NO_PRODUCT_PAGES_DISCOVERED: "We couldn't find product pages on this website.",
  ROBOTS_BLOCKED: "This website's crawling settings don't allow automatic catalog import.",
  ACCESS_DENIED: "This website doesn't currently allow us to access its product pages.",
  DYNAMIC_CONTENT: "This website appears to load its catalog dynamically and can't currently be imported automatically.",
  NETWORK_UNREACHABLE: "We couldn't reach the website. Check the URL and try again.",
  UNKNOWN: "We couldn't detect usable product information on this website.",
}

function describeBatchError(error) {
  if (error instanceof ApiError && error.body?.error) {
    switch (error.body.error) {
      case 'INVALID_URL':
        return 'Please enter a valid website address (starting with http:// or https://).'
      case 'URL_NOT_ALLOWED':
        return 'This address cannot be crawled (it points to a private or blocked network location).'
      case 'CRAWL_IN_PROGRESS':
        return 'A crawl is already running for this merchant. Please wait for it to finish.'
      case 'UNREACHABLE':
        return error.body.message || "We couldn't reach the website. Check the URL and try again."
      default:
        return error.message
    }
  }
  return 'Something went wrong. Please try again.'
}

function outcomeBadgeClass(outcome) {
  if (outcome === 'FAILED') return 'outcome-badge outcome-badge--failed'
  if (outcome === 'SKIPPED') return 'outcome-badge outcome-badge--warning'
  if (outcome === 'IMPORTED_WITH_WARNINGS') return 'outcome-badge outcome-badge--warning'
  return 'outcome-badge outcome-badge--imported'
}

function compatibilityBannerClass(result) {
  if (result === 'COMPATIBLE') return 'compatibility-banner compatibility-banner--compatible'
  if (result === 'PARTIALLY_COMPATIBLE') return 'compatibility-banner compatibility-banner--partial'
  return 'compatibility-banner compatibility-banner--unavailable'
}

function CrawlWebsite({ merchant, onBack, onDone, onSelectUpload, onSelectManual }) {
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState('input') // input | processing | summary
  const [summary, setSummary] = useState(null)
  const [batchError, setBatchError] = useState(null)

  function reset() {
    setUrl('')
    setSummary(null)
    setBatchError(null)
    setStage('input')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (url.trim() === '') return
    setStage('processing')
    setBatchError(null)
    try {
      const result = await crawlWebsite(merchant.id, url.trim())
      setSummary(result)
      setStage('summary')
    } catch (error) {
      setBatchError(describeBatchError(error))
      setStage('input')
    }
  }

  const compatibility = summary?.compatibility
  const isUnavailable = compatibility?.result === 'AUTOMATIC_IMPORT_UNAVAILABLE'

  return (
    <div className="upload-catalog">
      <div className="product-workspace__header">
        <button type="button" className="link-button" onClick={onBack}>
          ← Back
        </button>
        <h2>{merchant.name} — Crawl Website</h2>
      </div>

      {(stage === 'input' || stage === 'processing') && (
        <form className="upload-file-picker" onSubmit={handleSubmit}>
          <p className="field-hint">
            We look for structured product data first. Results vary by site — review everything in
            Pending Review before approving.
          </p>

          {batchError && (
            <div className="error-banner">
              <p>{batchError}</p>
            </div>
          )}

          <input
            type="url"
            aria-label="Website URL"
            placeholder="https://your-store.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={stage === 'processing'}
            required
          />

          <div className="product-form__actions">
            <button type="submit" disabled={url.trim() === '' || stage === 'processing'}>
              {stage === 'processing' ? 'Crawling…' : 'Start Crawl'}
            </button>
          </div>
        </form>
      )}

      {stage === 'summary' && summary && (
        <div className="upload-summary">
          {compatibility && !isUnavailable && (
            <div className={compatibilityBannerClass(compatibility.result)}>
              <p className="compatibility-banner__heading">{COMPATIBILITY_COPY[compatibility.result].heading}</p>
              <p>{COMPATIBILITY_COPY[compatibility.result].message}</p>
            </div>
          )}

          {compatibility && isUnavailable && (
            <div className={compatibilityBannerClass(compatibility.result)}>
              <p className="compatibility-banner__heading">We couldn&rsquo;t automatically import products from this website.</p>
              <p>{UNAVAILABLE_REASON_MESSAGES[compatibility.reasonCode] || UNAVAILABLE_REASON_MESSAGES.UNKNOWN}</p>
            </div>
          )}

          <p className="field-hint">
            Discovery method: <strong>{summary.discoveryMethod}</strong>
            {summary.stoppedEarly && ' — stopped early (crawl budget exhausted)'}
          </p>

          <div className="upload-summary__counts">
            <div className="upload-summary__stat">
              <span className="upload-summary__number">{summary.pagesFetched}</span>
              <span>Pages fetched</span>
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
            <div className="upload-summary__stat">
              <span className="upload-summary__number">{summary.skipped}</span>
              <span>Skipped</span>
            </div>
          </div>

          <ul className="upload-row-list">
            {summary.pages.map((page, index) => (
              <li key={index} className="upload-row">
                <span className="upload-row__name">{page.name || page.url}</span>
                <span className={outcomeBadgeClass(page.outcome)}>{page.outcome.replace(/_/g, ' ')}</span>
                <p className="field-hint" style={{ flexBasis: '100%' }}>
                  {page.url}
                </p>
                {page.errors && <p className="product-row__error">{page.errors.join('; ')}</p>}
                {page.warnings && <p className="field-hint">{page.warnings.join('; ')}</p>}
                {page.reason && <p className="field-hint">{page.reason}</p>}
              </li>
            ))}
          </ul>

          {!isUnavailable && (
            <div className="product-form__actions">
              <button type="button" onClick={onDone}>
                Go to Pending Review
              </button>
              <button type="button" onClick={reset}>
                Crawl another URL
              </button>
            </div>
          )}

          {isUnavailable && (
            <div className="product-form__actions">
              <button type="button" onClick={onSelectUpload}>
                Upload Catalog
              </button>
              <button type="button" onClick={onSelectManual}>
                Add Manually
              </button>
              <button type="button" onClick={reset}>
                Try Another URL
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default CrawlWebsite
