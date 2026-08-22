import { useState } from 'react'
import IngestionChoices from './IngestionChoices.jsx'
import ProductWorkspace from './ProductWorkspace.jsx'

function AICommerceSection({ merchant }) {
  const [view, setView] = useState('choices')

  if (view === 'manual') {
    return <ProductWorkspace merchant={merchant} onBack={() => setView('choices')} />
  }

  return <IngestionChoices onSelectManual={() => setView('manual')} />
}

export default AICommerceSection
