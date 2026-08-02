import { memo, useEffect, useState, type ReactElement } from 'react'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'

/**
 * Thin wrapper around the thinking-orbs canvas animation.
 *
 * - Follows the host app theme automatically (`theme="auto"` resolves
 *   `<html data-theme>` / `.dark` / `.light`, which legalwork sets).
 * - Honors `prefers-reduced-motion` by freezing the animation (paused),
 *   mirroring the CSS-based reduced-motion fallbacks used elsewhere.
 * - Wraps the canvas in a span so the fixed canvas size can't cause layout
 *   shift when the orb state swaps between presets.
 */
export const ThinkingOrbStatus = memo(function ThinkingOrbStatus({
  state,
  size = 20,
  className = '',
  ariaLabel
}: {
  state: OrbState
  size?: 20 | 64
  className?: string
  ariaLabel?: string
}): ReactElement {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return (
    <span className={className} aria-hidden={!ariaLabel}>
      <ThinkingOrb
        state={state}
        size={size}
        theme="auto"
        paused={reducedMotion}
        aria-label={ariaLabel}
      />
    </span>
  )
})
