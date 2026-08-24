import { useOutletContext } from 'react-router-dom'
import OpportunityWorkspace from './OpportunityWorkspace.jsx'

function OpportunitiesPage() {
  const { merchant } = useOutletContext()
  return <OpportunityWorkspace merchant={merchant} />
}

export default OpportunitiesPage
