import { Search, Sparkles, CheckCircle2, ShoppingBag, IndianRupee, Check } from 'lucide-react'

// One icon per step, in order — purely decorative, never implies anything
// the `done`/`value` flags (computed by the caller from real backend
// fields) don't already say.
const STEP_ICONS = [Search, Sparkles, CheckCircle2, ShoppingBag, IndianRupee]

// Phase 8 premium pass — the closed-loop visual: People asked → AI made
// product → You approved → Customer bought → Money earned. This is the
// product's signature moment, so it gets a connected progress line, solid
// completed-state nodes, and a visually stronger final "Money earned" step
// — never anything the `steps` data itself doesn't support.
function LoopTracker({ steps }) {
  const doneCount = steps.filter((step) => step.done).length
  const progressPercent = steps.length > 1 ? (Math.max(doneCount - 1, 0) / (steps.length - 1)) * 100 : 0

  return (
    <div className="loop-tracker">
      <div className="loop-tracker__track" aria-hidden="true">
        <div className="loop-tracker__track-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      <ol className="loop-tracker__steps">
        {steps.map((step, index) => {
          const Icon = STEP_ICONS[index] || Sparkles
          const isFinal = index === steps.length - 1
          return (
            <li
              key={index}
              className={`loop-tracker__step ${step.done ? 'loop-tracker__step--done' : ''} ${
                isFinal && step.done ? 'loop-tracker__step--payoff' : ''
              }`}
            >
              <span className="loop-tracker__node" aria-hidden="true">
                {step.done ? <Check size={15} strokeWidth={3} /> : <Icon size={14} strokeWidth={2} />}
              </span>
              <span className="loop-tracker__text">
                <span className="loop-tracker__label">{step.label}</span>
                {step.value && <span className="loop-tracker__value num-tabular">{step.value}</span>}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default LoopTracker
