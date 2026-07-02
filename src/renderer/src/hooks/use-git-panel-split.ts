import { useCallback, useEffect, useRef, useState } from 'react'

const LS_SCM = 'ola.gitPanel.scmWidth'
const LS_HIST = 'ola.gitPanel.historyWidth'

const GRIP_PX = 5
const CENTER_MIN = 200
const SCM_MIN = 200
const SCM_MAX = 580
const HIST_MIN = 180
const HIST_MAX = 560

function readStored(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    /* ignore */
  }
  return fallback
}

export function useGitPanelSplit(): {
  scmWidth: number
  historyWidth: number
  containerRef: React.RefObject<HTMLDivElement | null>
  onScmResizePointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onHistoryResizePointerDown: (e: React.PointerEvent<HTMLElement>) => void
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scmWidth, setScmWidth] = useState(() => readStored(LS_SCM, 360))
  const [historyWidth, setHistoryWidth] = useState(() => readStored(LS_HIST, 300))
  const scmRef = useRef(scmWidth)
  const histRef = useRef(historyWidth)

  useEffect(() => {
    scmRef.current = scmWidth
  }, [scmWidth])
  useEffect(() => {
    histRef.current = historyWidth
  }, [historyWidth])

  const onScmResizePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = scmRef.current

    const onMove = (ev: PointerEvent): void => {
      const cw = containerRef.current?.getBoundingClientRect().width ?? 960
      const maxScm = Math.min(SCM_MAX, cw - histRef.current - CENTER_MIN - GRIP_PX * 2)
      const w = Math.round(Math.min(maxScm, Math.max(SCM_MIN, startW + (ev.clientX - startX))))
      setScmWidth(w)
    }

    const onUp = (ev: PointerEvent): void => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      const cw = containerRef.current?.getBoundingClientRect().width ?? 960
      const maxScm = Math.min(SCM_MAX, cw - histRef.current - CENTER_MIN - GRIP_PX * 2)
      const w = Math.round(Math.min(maxScm, Math.max(SCM_MIN, startW + (ev.clientX - startX))))
      setScmWidth(w)
      try {
        localStorage.setItem(LS_SCM, String(w))
      } catch {
        /* ignore */
      }
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }, [])

  const onHistoryResizePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startH = histRef.current

    const onMove = (ev: PointerEvent): void => {
      const cw = containerRef.current?.getBoundingClientRect().width ?? 960
      const maxHist = Math.min(HIST_MAX, cw - scmRef.current - CENTER_MIN - GRIP_PX * 2)
      const delta = ev.clientX - startX
      const w = Math.round(Math.min(maxHist, Math.max(HIST_MIN, startH - delta)))
      setHistoryWidth(w)
    }

    const onUp = (ev: PointerEvent): void => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      const cw = containerRef.current?.getBoundingClientRect().width ?? 960
      const maxHist = Math.min(HIST_MAX, cw - scmRef.current - CENTER_MIN - GRIP_PX * 2)
      const delta = ev.clientX - startX
      const w = Math.round(Math.min(maxHist, Math.max(HIST_MIN, startH - delta)))
      setHistoryWidth(w)
      try {
        localStorage.setItem(LS_HIST, String(w))
      } catch {
        /* ignore */
      }
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }, [])

  return {
    scmWidth,
    historyWidth,
    containerRef,
    onScmResizePointerDown,
    onHistoryResizePointerDown
  }
}
