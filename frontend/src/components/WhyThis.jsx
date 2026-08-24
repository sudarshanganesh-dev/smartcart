import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

// Deterministic, backend-authored facts only (see explain.js on the
// backend) — this component just renders whatever `facts` it's given; it
// never invents, scores, or infers anything itself. Renders nothing if
// there are no provable facts to show.
function WhyThis({ facts, label = 'Why this?' }) {
  const [open, setOpen] = useState(false)

  if (!facts || facts.length === 0) return null

  return (
    <div className="why-this">
      <button type="button" className="why-this__toggle" onClick={() => setOpen((v) => !v)}>
        {label}
        <ChevronDown
          size={13}
          strokeWidth={2.25}
          className={`why-this__chevron ${open ? 'why-this__chevron--open' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul className="why-this__list">
          {facts.map((fact) => (
            <li key={fact.id} className="why-this__item">
              <Check size={12} strokeWidth={2.5} aria-hidden="true" />
              {fact.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default WhyThis
