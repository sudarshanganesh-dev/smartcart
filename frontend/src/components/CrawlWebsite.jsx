import { useState } from 'react'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { crawlWebsite, ApiError } from '../lib/api.js'

// Factual, matches extractProduct.js's real field set exactly (name,
// description/category as "product details", price, availability) - no
// image import exists in the extractor, so it is never claimed here.
const LOOKS_FOR_ITEMS = ['Product name', 'Price', 'Availability', 'Product details']

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
    <div className="crawl-website">
      <div>
        <button type="button" className="link-button" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" />
          <span>Back to Catalog</span>
        </button>
        <div className="page-header crawl-website__intro">
          <h1>Crawl your website</h1>
          <p className="field-hint">
            Import products from your existing website. SmartCart detects structured product data first, then
            sends everything to Pending Review before anything can go live.
          </p>
        </div>
      </div>

      {(stage === 'input' || stage === 'processing') && (
        <>
          <div className="crawl-website__card">
            <form className="crawl-website__form" onSubmit={handleSubmit}>
              {batchError && (
                <div className="error-banner">
                  <p>{batchError}</p>
                </div>
              )}

              <label className="crawl-website__field">
                Website URL
                <input
                  type="url"
                  aria-label="Website URL"
                  placeholder="https://your-store.example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={stage === 'processing'}
                  required
                />
              </label>

              <button type="submit" className="btn-primary crawl-website__submit" disabled={url.trim() === '' || stage === 'processing'}>
                {stage === 'processing' ? 'Crawling…' : 'Start website crawl'}
              </button>

              {stage === 'processing' && (
                <p className="crawl-website__progress">
                  <span className="crawl-website__spinner" aria-hidden="true" />
                  Crawling your website…
                </p>
              )}

              <ul className="crawl-website__trust-notes">
                <li>
                  <CheckCircle2 size={14} strokeWidth={2.25} aria-hidden="true" />
                  <span>Imported products stay in Pending Review</span>
                </li>
                <li>
                  <CheckCircle2 size={14} strokeWidth={2.25} aria-hidden="true" />
                  <span>Nothing goes live without merchant approval</span>
                </li>
              </ul>
            </form>
          </div>

          <div className="crawl-website__info">
            <h4>What SmartCart looks for</h4>
            <div className="crawl-website__info-grid">
              {LOOKS_FOR_ITEMS.map((item) => (
                <span key={item} className="crawl-website__info-item">
                  {item}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {stage === 'summary' && summary && (
        <div className="crawl-website__card">
          <div className="upload-summary">
            {!isUnavailable && (
              <div className="crawl-website__result-headline">
                <h3>
                  {summary.imported} product{summary.imported === 1 ? '' : 's'} imported
                </h3>
                <p>Your products were added to Pending Review.</p>
              </div>
            )}

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
              {summary.stoppedEarly && ' - stopped early (crawl budget exhausted)'}
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
                <button type="button" className="btn-primary" onClick={onDone}>
                  Review imported products
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
        </div>
      )}
    </div>
  )
}

export default CrawlWebsite
