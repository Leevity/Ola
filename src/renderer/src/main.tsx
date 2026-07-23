import './assets/main.css'
import './stores/quota-store'
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { installStreamingPerfMonitor } from './lib/streaming-perf'

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

if (!isNotifyWindow && !isPetWindow) installStreamingPerfMonitor()

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={null}>
    <Root />
  </Suspense>
)
