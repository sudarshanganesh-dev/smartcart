import { useState } from 'react'
import IngestionChoices from './IngestionChoices.jsx'
import ProductWorkspace from './ProductWorkspace.jsx'
import UploadCatalog from './UploadCatalog.jsx'
import CrawlWebsite from './CrawlWebsite.jsx'

function AICommerceSection({ merchant }) {
  const [view, setView] = useState('choices')

  if (view === 'manual') {
    return <ProductWorkspace merchant={merchant} onBack={() => setView('choices')} />
  }

  if (view === 'upload') {
    return (
      <UploadCatalog
        merchant={merchant}
        onBack={() => setView('choices')}
        onDone={() => setView('manual')}
      />
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
    <IngestionChoices
      onSelectManual={() => setView('manual')}
      onSelectUpload={() => setView('upload')}
      onSelectCrawl={() => setView('crawl')}
    />
  )
}

export default AICommerceSection
