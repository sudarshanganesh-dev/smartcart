import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../lib/api.js'

function ConnectionStatus() {
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

  if (status.loading) {
    return <span className="connection-status">Checking connection…</span>
  }

  return (
    <span className="connection-status">
      Backend: {status.backendConnected ? 'Connected' : 'Disconnected'} · Database:{' '}
      {status.databaseConnected ? 'Connected' : 'Disconnected'}
    </span>
  )
}

export default ConnectionStatus
