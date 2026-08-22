function IngestionChoices({ onSelectManual, onSelectUpload, onSelectCrawl }) {
  return (
    <div className="ingestion-choices">
      <div className="ingestion-card">
        <h3>Crawl Website</h3>
        <p>Import products by crawling your existing website.</p>
        <button type="button" onClick={onSelectCrawl}>
          Start
        </button>
      </div>

      <div className="ingestion-card">
        <h3>Upload Catalog</h3>
        <p>Import products from a structured CSV or JSON file.</p>
        <button type="button" onClick={onSelectUpload}>
          Start
        </button>
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
