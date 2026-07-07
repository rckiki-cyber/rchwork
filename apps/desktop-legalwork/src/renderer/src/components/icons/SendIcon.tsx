import type { ReactElement, SVGProps } from 'react'

export function SendIcon(props: Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'>): ReactElement {
  const { className, ...rest } = props
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {/**
       * A modern, filled paper-plane icon with rounded corners.
       * Designed to feel more premium than the default outline send icon.
       */}
      <path d="M2.5 12.35a1.4 1.4 0 0 1 .73-1.57l16.33-8.38a1.4 1.4 0 0 1 1.98 1.66l-4.2 16.38a1.4 1.4 0 0 1-2.5.51l-3.96-5.72-5.72-3.96a1.4 1.4 0 0 1-.66-.92z" />
    </svg>
  )
}
