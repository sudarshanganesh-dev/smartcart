import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getOpportunities,
  getOpportunity,
  dismissOpportunity,
  generateOpportunityDraft,
  approveProduct,
  rejectProduct,
  updateProduct,
  ApiError,
} from '../lib/api.js'
import { describePriceViolation } from '../lib/pricePolicyMessages.js'
import OpportunityList from './OpportunityList.jsx'
import OpportunityDetail from './OpportunityDetail.jsx'

const TABS = [
  { key: 'OPEN', label: 'Open' },
  { key: 'ACTIONED', label: 'Actioned' },
  { key: 'DISMISSED', label: 'Dismissed' },
]

// `price` is the generated product's own current price (already known from
// `detail.generatedProduct` at the call site) — only ever relevant for the
// approve action, passed through so PRICE_VIOLATES_DEMAND_POLICY can name
// the exact number that was rejected via the shared describePriceViolation
// (same wording ProductList.jsx's row-level Approve uses — never a second,
// drifting copy).
function describeActionError(error, price) {
  if (error instanceof ApiError && error.body?.error) {
    switch (error.body.error) {
      case 'OPPORTUNITY_NOT_OPEN':
        return 'This opportunity is no longer open.'
      case 'MERCHANDISING_PROPOSAL_INVALID':
        return "The generated proposal didn't pass validation - please try again."
      case 'INSUFFICIENT_PRODUCT_INTENT':
        return "This opportunity has no specific product intent to act on - SmartCart can't generate a draft from it."
      case 'PROPOSAL_EXCEEDS_DEMAND_CEILING':
        return "The generated price was higher than what observed demand supports - please try again."
      case 'PROPOSAL_NOT_LOWER_PRICED':
        return "The generated price wasn't actually lower than your existing product - please try again."
      case 'APPROVAL_REQUIREMENTS_NOT_MET':
        return 'This product needs a price before it can be approved - set one above.'
      case 'INVALID_STATUS_TRANSITION':
        return 'This product has already been reviewed.'
      case 'PRICE_VIOLATES_DEMAND_POLICY': {
        const details = error.body.details || []
        if (details.length === 0) return 'This price does not match observed demand.'
        return details.map((detail) => describePriceViolation(detail, price)).join(' ')
      }
      case 'DEMAND_POLICY_UNVERIFIABLE':
        return "SmartCart can't verify this product's original demand evidence anymore, so it can't be approved as-is."
      default:
        return 'Something went wrong. Please try again.'
    }
  }
  return 'Something went wrong. Please try again.'
}

// Phase 7: read-only insight + two lifecycle actions (generate-draft,
// dismiss). No auto-publish path exists anywhere in this component.
function OpportunityWorkspace({ merchant }) {
  // Tiny, safe deep-link: Feature 3's Attention Queue can send the merchant
  // straight to one specific opportunity (?id=...) instead of only the bare
  // list — read once on mount, below, and never written back into the URL
  // by anything else in this component.
  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinkId = searchParams.get('id')

  const [activeTab, setActiveTab] = useState('OPEN')
  const [opportunities, setOpportunities] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)

  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)
  const [actionState, setActionState] = useState('idle') // idle | generating | dismissing | approving | rejecting | savingSetup
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

  // Runs once, only when the page was opened with ?id= — never re-triggers
  // on a later tab change, and never fights with a manual list->detail
  // selection (selectedId is only ever set here or by openOpportunity below).
  useEffect(() => {
    if (deepLinkId) {
      openOpportunity(deepLinkId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    if (deepLinkId) setSearchParams({})
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

  // Feature 3 demo-hardening fix — lets the merchant set a fresh AI draft's
  // price, availability, and stock quantity right here instead of a
  // separate trip to Catalog. Reuses the EXACT SAME PATCH endpoint Catalog's
  // own edit form calls (updateProduct -> PATCH /products/:id), which
  // re-runs validateGeneratedProductPrice server-side exactly as it always
  // has — this handler adds no new validation of its own, it only submits
  // what the merchant chose and refetches.
  async function handleSaveProductSetup(payload) {
    if (!detail?.generatedProduct?.id) return
    setActionState('savingSetup')
    setActionError(null)
    try {
      await updateProduct(merchant.id, detail.generatedProduct.id, payload)
      const refreshed = await getOpportunity(merchant.id, selectedId)
      setDetail(refreshed)
    } catch (error) {
      setActionError(describeActionError(error, payload.price))
    } finally {
      setActionState('idle')
    }
  }

  async function handleApproveProduct() {
    if (!detail?.generatedProduct?.id) return
    setActionState('approving')
    setActionError(null)
    try {
      await approveProduct(merchant.id, detail.generatedProduct.id)
      const refreshed = await getOpportunity(merchant.id, selectedId)
      setDetail(refreshed)
    } catch (error) {
      setActionError(describeActionError(error, detail.generatedProduct.price))
    } finally {
      setActionState('idle')
    }
  }

  async function handleRejectProduct() {
    if (!detail?.generatedProduct?.id) return
    setActionState('rejecting')
    setActionError(null)
    try {
      await rejectProduct(merchant.id, detail.generatedProduct.id)
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
        onApproveProduct={handleApproveProduct}
        onRejectProduct={handleRejectProduct}
        onSaveProductSetup={handleSaveProductSetup}
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
