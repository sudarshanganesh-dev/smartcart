import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import IngestionChoices from './IngestionChoices.jsx'
import ProductWorkspace from './ProductWorkspace.jsx'
import UploadCatalog from './UploadCatalog.jsx'
import CrawlWebsite from './CrawlWebsite.jsx'

// Phase 8: absorbs AICommerceSection.jsx's former renderCatalog() logic
// verbatim — the ingestion flow itself (choices/manual/upload/crawl) is
// completely unchanged, just re-parented under the /merchant/catalog route.
function CatalogPage() {
  const { merchant } = useOutletContext()
  const [view, setView] = useState('choices')

  if (view === 'manual') {
    return <ProductWorkspace merchant={merchant} onBack={() => setView('choices')} />
  }

  if (view === 'upload') {
    return (
      <UploadCatalog merchant={merchant} onBack={() => setView('choices')} onDone={() => setView('manual')} />
    )
  }

  if (view === 'crawl') {
    return (
      <CrawlWebsite
        merchant={merchant}
        onBack={() => setView('choices')}
        onDone={() => setView('manual')}
        onSelectUpload={() => setView('upload')}
        onSelectManual={() => setView('manual')}
      />
    )
  }

  return (
    <div className="catalog-landing">
      <div className="catalog-landing__view-products">
        <div>
          <h3>Your catalog</h3>
          <p>See and manage the products you already have.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setView('manual')}>
          View Products
        </button>
      </div>

      <IngestionChoices
        onSelectManual={() => setView('manual')}
        onSelectUpload={() => setView('upload')}
        onSelectCrawl={() => setView('crawl')}
      />
    </div>
  )
}

export default CatalogPage
