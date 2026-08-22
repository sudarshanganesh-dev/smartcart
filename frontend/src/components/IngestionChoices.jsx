function IngestionChoices({ onSelectManual }) {
  return (
    <div className="ingestion-choices">
      <div className="ingestion-card ingestion-card--disabled">
        <h3>Crawl Website</h3>
        <p>Import products by crawling your existing website.</p>
        <span className="ingestion-card__tag">Coming next</span>
      </div>

      <div className="ingestion-card ingestion-card--disabled">
        <h3>Upload Catalog</h3>
        <p>Import products from a structured CSV or JSON file.</p>
        <span className="ingestion-card__tag">Coming next</span>
      </div>

      <div className="ingestion-card">
        <h3>Add Manually</h3>
        <p>Create and manage products one at a time.</p>
        <button type="button" onClick={onSelectManual}>
          Start
        </button>
      </div>
    </div>
  )
}

export default IngestionChoices
