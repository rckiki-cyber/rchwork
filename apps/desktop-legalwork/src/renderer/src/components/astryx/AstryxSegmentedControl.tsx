import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export type AstryxSegmentedItem<T extends string> = {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  title?: string
}

type Props<T extends string> = {
  value: T
  items: readonly AstryxSegmentedItem<T>[]
  onChange: (value: T) => void
  onReselect?: (value: T) => void
  ariaLabel: string
  className?: string
  buttonClassName?: string
  indicatorClassName?: string
  activeClassName?: string
  inactiveClassName?: string
}

type IndicatorRect = {
  x: number
  y: number
  width: number
  height: number
}

export function AstryxSegmentedControl<T extends string>({
  value,
  items,
  onChange,
  onReselect,
  ariaLabel,
  className = '',
  buttonClassName = '',
  indicatorClassName = '',
  activeClassName = '',
  inactiveClassName = ''
}: Props<T>): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [visualValue, setVisualValue] = useState(value)
  const [indicator, setIndicator] = useState<IndicatorRect | null>(null)
  const enabledItems = useMemo(() => items.filter((item) => !item.disabled), [items])

  const findButton = useCallback((segmentValue: T): HTMLElement | undefined => {
    return Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[data-astryx-segment-value]') ?? []
    ).find((button) => button.dataset.astryxSegmentValue === segmentValue)
  }, [])

  useEffect(() => {
    setVisualValue(value)
  }, [value])

  const updateIndicator = useCallback(() => {
    const activeButton = findButton(visualValue)
    if (!activeButton) {
      setIndicator(null)
      return
    }
    const next = {
      x: activeButton.offsetLeft,
      y: activeButton.offsetTop,
      width: activeButton.offsetWidth,
      height: activeButton.offsetHeight
    }
    setIndicator((current) =>
      current?.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
        ? current
        : next
    )
  }, [findButton, visualValue])

  useLayoutEffect(() => {
    updateIndicator()
  }, [items, updateIndicator])

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateIndicator)
    observer.observe(root)
    window.addEventListener('resize', updateIndicator)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateIndicator)
    }
  }, [updateIndicator])

  const select = useCallback(
    (nextValue: T) => {
      setVisualValue(nextValue)
      dispatchSegmentSelection(nextValue, value, onChange, onReselect)
    },
    [onChange, onReselect, value]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        return
      }
      event.preventDefault()
      if (enabledItems.length === 0) return
      const currentIndex = enabledItems.findIndex((item) => item.value === visualValue)
      let nextIndex = currentIndex
      if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = enabledItems.length - 1
      else {
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
        nextIndex = (Math.max(0, currentIndex) + direction + enabledItems.length) % enabledItems.length
      }
      const nextItem = enabledItems[nextIndex]
      if (!nextItem) return
      select(nextItem.value)
      findButton(nextItem.value)?.focus()
    },
    [enabledItems, findButton, select, visualValue]
  )

  const indicatorStyle: CSSProperties | undefined = indicator
    ? {
        width: indicator.width,
        height: indicator.height,
        transform: `translate3d(${indicator.x}px, ${indicator.y}px, 0)`,
        opacity: 1
      }
    : undefined

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`astryx-segmented-control relative ${className}`}
      onKeyDown={handleKeyDown}
    >
      <span
        aria-hidden="true"
        data-astryx-segment-indicator
        className={`absolute left-0 top-0 pointer-events-none ${indicatorClassName}`}
        style={indicatorStyle}
      />
      {items.map((item) => {
        const active = visualValue === item.value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={value === item.value}
            tabIndex={value === item.value ? 0 : -1}
            disabled={item.disabled}
            title={item.title}
            data-astryx-segment-value={item.value}
            data-state={active ? 'active' : 'inactive'}
            onPointerDown={() => {
              if (!item.disabled) setVisualValue(item.value)
            }}
            onPointerCancel={() => setVisualValue(value)}
            onClick={() => select(item.value)}
            className={`astryx-segmented-button relative z-[1] ${buttonClassName} ${
              active ? activeClassName : inactiveClassName
            }`}
          >
            {item.icon ? <span data-astryx-segment-icon>{item.icon}</span> : null}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function dispatchSegmentSelection<T extends string>(
  nextValue: T,
  currentValue: T,
  onChange: (value: T) => void,
  onReselect?: (value: T) => void
): void {
  if (nextValue === currentValue) {
    onReselect?.(nextValue)
    return
  }
  onChange(nextValue)
}
