import { useEffect, useState } from 'react'
import './App.css'
import { getMerchants } from './lib/api.js'
import ConnectionStatus from './components/ConnectionStatus.jsx'
import AICommerceSection from './components/AICommerceSection.jsx'
import CustomerChat from './components/CustomerChat.jsx'

function App() {
  const [view, setView] = useState('merchant') // 'merchant' | 'customer'
  const [merchant, setMerchant] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadMerchant()
  }, [])

  async function loadMerchant() {
    setLoading(true)
    setError(null)
    try {
      const merchants = await getMerchants()
      const demo = merchants.find((m) => m.slug === 'demo-merchant') || merchants[0]
      if (!demo) {
        setError('No merchant found. Seed a demo merchant on the backend first.')
      } else {
        setMerchant(demo)
      }
    } catch {
      setError('Could not load merchant from the backend.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Commerce Layer</h1>
        <nav className="view-toggle">
          <button
            type="button"
            className={`view-toggle__button ${view === 'merchant' ? 'view-toggle__button--active' : ''}`}
            onClick={() => setView('merchant')}
          >
            Merchant
          </button>
          <button
            type="button"
            className={`view-toggle__button ${view === 'customer' ? 'view-toggle__button--active' : ''}`}
            onClick={() => setView('customer')}
          >
            Customer
          </button>
        </nav>
        <ConnectionStatus />
      </header>

      <main className="app-main">
        {view === 'customer' && <CustomerChat />}

        {view === 'merchant' && (
          <>
            {loading && <p>Loading merchant…</p>}

            {!loading && error && (
              <div className="error-banner">
                <p>{error}</p>
                <button type="button" onClick={loadMerchant}>
                  Retry
                </button>
              </div>
            )}

            {!loading && !error && merchant && <AICommerceSection merchant={merchant} />}
          </>
        )}
      </main>
    </div>
  )
}

export default App
