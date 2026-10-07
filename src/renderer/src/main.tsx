import './assets/main.css'
import './stores/quota-store'
import { lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installStreamingPerfMonitor } from './lib/streaming-perf'
import { ensureWindowWorkspaceRegistered } from './lib/window-workspace-registration'
import { useWorkspaceStore } from './stores/workspace-store'

const App = lazy(() => import('./App'))
const NotifyWindow = lazy(() =>
  import('./components/notify/NotifyWindow').then(({ NotifyWindow }) => ({ default: NotifyWindow }))
)
const PetWindow = lazy(() =>
  import('./components/pet/PetWindow').then(({ PetWindow }) => ({ default: PetWindow }))
)

const isNotifyWindow = window.location.hash.startsWith('#notify')
const isPetWindow = new URLSearchParams(window.location.search).get('appView') === 'pet'
const Root = isNotifyWindow ? NotifyWindow : isPetWindow ? PetWindow : App

function RegisteredRoot(): React.JSX.Element | null {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    const registerInitialWorkspace = async (): Promise<void> => {
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
      try {
        await ensureWindowWorkspaceRegistered(workspaceId)
      } catch (error) {
        console.warn('[Renderer] Initial workspace registration failed', error)
        if (workspaceId !== 'local-personal') {
          useWorkspaceStore.getState().setActiveWorkspace('local-personal')
          await ensureWindowWorkspaceRegistered('local-personal')
        }
      } finally {
        if (active) setReady(true)
      }
    }
    void registerInitialWorkspace()
    return () => {
      active = false
    }
  }, [])

  return ready ? (
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  ) : null
}

if (!isNotifyWindow && !isPetWindow) installStreamingPerfMonitor()

createRoot(document.getElementById('root')!).render(
  isNotifyWindow ? (
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  ) : (
    <RegisteredRoot />
  )
)
