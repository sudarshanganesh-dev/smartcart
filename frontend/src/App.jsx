import { useEffect, useState } from 'react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'

function App() {
  const [status, setStatus] = useState({ loading: true, backendConnected: false, databaseConnected: false })

  useEffect(() => {
    let cancelled = false

    fetch(`${API_BASE_URL}/api/health`)
      .then((res) => {
        if (!res.ok) throw new Error('Bad response')
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setStatus({
          loading: false,
          backendConnected: data.status === 'ok',
          databaseConnected: Boolean(data.database?.connected),
        })
      })
      .catch(() => {
        if (cancelled) return
        setStatus({ loading: false, backendConnected: false, databaseConnected: false })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="status-page">
      <h1>AI Commerce Layer</h1>

      {status.loading ? (
        <p>Checking connection...</p>
      ) : (
        <ul>
          <li>Backend: {status.backendConnected ? 'Connected' : 'Disconnected'}</li>
          <li>Database: {status.databaseConnected ? 'Connected' : 'Disconnected'}</li>
        </ul>
      )}
    </section>
  )
}

export default App
