import './assets/main.css'
import './stores/quota-store'
import { createRoot } from 'react-dom/client'
import App from './App'
import { NotifyWindow } from './components/notify/NotifyWindow'
import { installStreamingPerfMonitor } from './lib/streaming-perf'

const isNotifyWindow = window.location.hash.startsWith('#notify')

installStreamingPerfMonitor()

createRoot(document.getElementById('root')!).render(isNotifyWindow ? <NotifyWindow /> : <App />)
