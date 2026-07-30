import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useChatStore } from './store/chat-store'
import { supportsDesktopTitleBar, WindowsTitleBar } from './components/WindowsTitleBar'

const Workbench = lazy(() =>
  import('./components/Workbench').then((module) => ({ default: module.Workbench }))
)
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((module) => ({ default: module.SettingsView }))
)
const InitialSetupDialog = lazy(() =>
  import('./components/InitialSetupDialog').then((module) => ({
    default: module.InitialSetupDialog
  }))
)

function RouteFallback(): React.ReactElement {
  return <div className="h-full bg-ds-main" />
}

export default function AppShell(): React.ReactElement {
  const route = useChatStore((s) => s.route)
  const boot = useChatStore((s) => s.boot)
  const initialSetupOpen = useChatStore((s) => s.initialSetupOpen)
  const platform = typeof window !== 'undefined' ? window.dsGui?.platform ?? 'unknown' : 'unknown'
  const hasDesktopTitleBar = supportsDesktopTitleBar(platform)
  const liquidPointerFrameRef = useRef(0)
  const liquidPointerEnabledRef = useRef(false)
  const liquidPointerSurfaceRef = useRef<HTMLElement | null>(null)
  const liquidPointerRectRef = useRef<DOMRect | null>(null)
  const liquidPointerSampleRef = useRef<{
    surface: HTMLElement
    clientX: number
    clientY: number
  } | null>(null)
  const sidebarHoverRootRef = useRef<HTMLElement | null>(null)
  const sidebarHoverTargetRef = useRef<HTMLElement | null>(null)
  const sidebarHoverPointRef = useRef<{
    clientX: number
    clientY: number
  } | null>(null)

  useEffect(() => {
    let frame = 0
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        void boot()
      })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [boot])

  useEffect(() => {
    const finePointer = window.matchMedia('(pointer: fine)')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const syncPointerPreference = (): void => {
      liquidPointerEnabledRef.current = finePointer.matches && !reducedMotion.matches
    }
    const invalidatePointerRect = (): void => {
      liquidPointerRectRef.current = null
    }

    syncPointerPreference()
    finePointer.addEventListener('change', syncPointerPreference)
    reducedMotion.addEventListener('change', syncPointerPreference)
    window.addEventListener('resize', invalidatePointerRect)

    return () => {
      finePointer.removeEventListener('change', syncPointerPreference)
      reducedMotion.removeEventListener('change', syncPointerPreference)
      window.removeEventListener('resize', invalidatePointerRect)
      if (liquidPointerFrameRef.current) {
        window.cancelAnimationFrame(liquidPointerFrameRef.current)
      }
    }
  }, [])

  const hideSidebarHover = (): void => {
    sidebarHoverRootRef.current?.removeAttribute('data-shared-hover-active')
    sidebarHoverRootRef.current = null
    sidebarHoverTargetRef.current = null
  }

  const updateSidebarHover = (origin: Element, force = false): void => {
    const root = origin.closest<HTMLElement>(
      '[data-sidebar-hover-root], [data-control-hover-root]'
    )
    const candidateTarget = origin.closest<HTMLElement>(
      '[data-sidebar-hover-target]:not(:disabled), [data-control-hover-target]:not(:disabled), [data-control-hover-root] button:not(:disabled):not([role="switch"]):not([data-control-hover-ignore])'
    )
    if (!root) {
      hideSidebarHover()
      return
    }
    const target = candidateTarget && root.contains(candidateTarget)
      ? candidateTarget
      : null
    if (!target) {
      if (root !== sidebarHoverRootRef.current) hideSidebarHover()
      return
    }
    if (!force && target === sidebarHoverTargetRef.current && root === sidebarHoverRootRef.current) return

    if (sidebarHoverRootRef.current && sidebarHoverRootRef.current !== root) {
      sidebarHoverRootRef.current.removeAttribute('data-shared-hover-active')
    }
    const indicator = root.hasAttribute('data-control-hover-root')
      ? root
      : root.querySelector<HTMLElement>('[data-sidebar-hover-indicator]')
    if (!indicator) return
    const rootRect = root.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const scaleX = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1
    const scaleY = root.offsetHeight > 0 ? rootRect.height / root.offsetHeight : 1
    indicator.style.setProperty(
      '--shared-hover-x',
      `${(targetRect.left - rootRect.left) / scaleX + root.scrollLeft}px`
    )
    indicator.style.setProperty(
      '--shared-hover-y',
      `${(targetRect.top - rootRect.top) / scaleY + root.scrollTop}px`
    )
    indicator.style.setProperty('--shared-hover-width', `${targetRect.width / scaleX}px`)
    indicator.style.setProperty('--shared-hover-height', `${targetRect.height / scaleY}px`)
    indicator.style.setProperty(
      '--shared-hover-radius',
      window.getComputedStyle(target).borderRadius
    )
    root.setAttribute('data-shared-hover-active', 'true')
    sidebarHoverRootRef.current = root
    sidebarHoverTargetRef.current = target
  }

  const handleLiquidPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const origin = event.target
    if (!(origin instanceof Element)) return
    sidebarHoverPointRef.current = {
      clientX: event.clientX,
      clientY: event.clientY
    }
    updateSidebarHover(origin)
    if (!liquidPointerEnabledRef.current) return
    const surface = origin.closest<HTMLElement>('[data-liquid-reactive]')
    if (!surface) return

    if (liquidPointerSurfaceRef.current !== surface) {
      liquidPointerSurfaceRef.current?.removeAttribute('data-liquid-pointer')
      liquidPointerSurfaceRef.current = surface
      liquidPointerRectRef.current = surface.getBoundingClientRect()
    }
    surface.setAttribute('data-liquid-pointer', 'inside')
    liquidPointerSampleRef.current = {
      surface,
      clientX: event.clientX,
      clientY: event.clientY
    }
    if (liquidPointerFrameRef.current) return

    liquidPointerFrameRef.current = window.requestAnimationFrame(() => {
      liquidPointerFrameRef.current = 0
      const sample = liquidPointerSampleRef.current
      if (!sample) return
      const rect = liquidPointerRectRef.current ?? sample.surface.getBoundingClientRect()
      liquidPointerRectRef.current = rect
      if (!rect.width || !rect.height) return
      const x = Math.min(100, Math.max(0, ((sample.clientX - rect.left) / rect.width) * 100))
      const y = Math.min(100, Math.max(0, ((sample.clientY - rect.top) / rect.height) * 100))
      sample.surface.style.setProperty('--lg-light-x', `${x.toFixed(2)}%`)
      sample.surface.style.setProperty('--lg-light-y', `${y.toFixed(2)}%`)
    })
  }

  const handleLiquidPointerOut = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const origin = event.target
    if (!(origin instanceof Element)) return
    const destination = event.relatedTarget
    const currentHoverRoot = origin.closest<HTMLElement>(
      '[data-sidebar-hover-root], [data-control-hover-root]'
    )
    const nextHoverRoot =
      destination instanceof Element
        ? destination.closest<HTMLElement>(
            '[data-sidebar-hover-root], [data-control-hover-root]'
          )
        : null
    if (currentHoverRoot && currentHoverRoot !== nextHoverRoot) {
      sidebarHoverPointRef.current = null
      hideSidebarHover()
    }

    const currentSurface = origin.closest<HTMLElement>('[data-liquid-reactive]')
    if (!currentSurface) return
    const nextSurface =
      destination instanceof Element
        ? destination.closest<HTMLElement>('[data-liquid-reactive]')
        : null
    if (currentSurface === nextSurface) return
    currentSurface.removeAttribute('data-liquid-pointer')
    if (liquidPointerSurfaceRef.current === currentSurface) {
      liquidPointerSurfaceRef.current = null
      liquidPointerRectRef.current = null
    }
  }

  const handleLiquidScroll = (): void => {
    const point = sidebarHoverPointRef.current
    if (!point) return
    const origin = document.elementFromPoint(point.clientX, point.clientY)
    if (origin instanceof Element) {
      updateSidebarHover(origin, true)
    } else {
      hideSidebarHover()
    }
  }

  return (
    <div
      className={
        hasDesktopTitleBar
          ? 'apple-liquid-app ds-windows-app-frame flex h-full min-h-0 flex-col bg-ds-main'
          : 'apple-liquid-app flex h-full min-h-0 flex-col bg-transparent'
      }
      onPointerMove={handleLiquidPointerMove}
      onPointerOut={handleLiquidPointerOut}
      onScrollCapture={handleLiquidScroll}
    >
      {hasDesktopTitleBar ? <WindowsTitleBar platform={platform} /> : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<RouteFallback />}>
          {route === 'settings' ? <SettingsView /> : <Workbench />}
        </Suspense>
      </div>
      {initialSetupOpen ? (
        <Suspense fallback={null}>
          <InitialSetupDialog />
        </Suspense>
      ) : null}
    </div>
  )
}
