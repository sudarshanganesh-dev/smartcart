import { useCallback, useEffect, useState } from 'react'
import { getOpportunities, getOpportunity, dismissOpportunity, generateOpportunityDraft, ApiError } from '../lib/api.js'
import OpportunityList from './OpportunityList.jsx'
import OpportunityDetail from './OpportunityDetail.jsx'

const TABS = [
  { key: 'OPEN', label: 'Open' },
  { key: 'ACTIONED', label: 'Actioned' },
  { key: 'DISMISSED', label: 'Dismissed' },
]

function describeActionError(error) {
  if (error instanceof ApiError && error.body?.error) {
    switch (error.body.error) {
      case 'OPPORTUNITY_NOT_OPEN':
        return 'This opportunity is no longer open.'
      case 'MERCHANDISING_PROPOSAL_INVALID':
        return "The generated proposal didn't pass validation — please try again."
      default:
        return 'Something went wrong. Please try again.'
    }
  }
  return 'Something went wrong. Please try again.'
}

// Phase 7: read-only insight + two lifecycle actions (generate-draft,
// dismiss). No auto-publish path exists anywhere in this component.
function OpportunityWorkspace({ merchant }) {
  const [activeTab, setActiveTab] = useState('OPEN')
  const [opportunities, setOpportunities] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)

  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)
  const [actionState, setActionState] = useState('idle') // idle | generating | dismissing
  const [actionError, setActionError] = useState(null)

  const fetchOpportunities = useCallback(
    async (status) => {
      setLoading(true)
      setListError(null)
      try {
        const data = await getOpportunities(merchant.id, status)
        setOpportunities(data)
      } catch (error) {
        setListError(error.message || 'Failed to load opportunities')
      } finally {
        setLoading(false)
      }
    },
    [merchant.id]
  )

  useEffect(() => {
    Promise.resolve().then(() => fetchOpportunities(activeTab))
  }, [activeTab, fetchOpportunities])

  async function openOpportunity(id) {
    setSelectedId(id)
    setActionError(null)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const data = await getOpportunity(merchant.id, id)
      setDetail(data)
    } catch (error) {
      setDetailError(error.message || 'Failed to load this opportunity')
    } finally {
      setDetailLoading(false)
    }
  }

  function backToList() {
    setSelectedId(null)
    setDetail(null)
    setDetailError(null)
    setActionError(null)
    Promise.resolve().then(() => fetchOpportunities(activeTab))
  }

  async function handleDismiss() {
    setActionState('dismissing')
    setActionError(null)
    try {
      const updated = await dismissOpportunity(merchant.id, selectedId)
      setDetail(updated)
    } catch (error) {
      setActionError(describeActionError(error))
    } finally {
      setActionState('idle')
    }
  }

  async function handleGenerateDraft() {
    setActionState('generating')
    setActionError(null)
    try {
      await generateOpportunityDraft(merchant.id, selectedId)
      const refreshed = await getOpportunity(merchant.id, selectedId)
      setDetail(refreshed)
    } catch (error) {
      setActionError(describeActionError(error))
    } finally {
      setActionState('idle')
    }
  }

  if (selectedId) {
    return (
      <OpportunityDetail
        opportunity={detail}
        loading={detailLoading}
        error={detailError}
        onBack={backToList}
        onRetry={() => openOpportunity(selectedId)}
        onDismiss={handleDismiss}
        onGenerateDraft={handleGenerateDraft}
        actionState={actionState}
        actionError={actionError}
      />
    )
  }

  return (
    <div className="order-workspace">
      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab ${activeTab === tab.key ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && <p>Loading opportunities…</p>}

      {!loading && listError && (
        <div className="error-banner">
          <p>{listError}</p>
          <button type="button" onClick={() => fetchOpportunities(activeTab)}>
            Retry
          </button>
        </div>
      )}

      {!loading && !listError && <OpportunityList opportunities={opportunities} onSelect={openOpportunity} />}
    </div>
  )
}

export default OpportunityWorkspace
