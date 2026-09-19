import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginWindowWorkspaceRegistration,
  getRegisteredWindowWorkspace,
  getTrustedWorkspaceRegistrationWindow,
  registerWindowWorkspace,
  safeSendMessagePackToWorkspaceWindows
} from '../../src/main/window-ipc'

const testRoot = process.env.OLA_ELECTRON_IPC_TEST_ROOT
if (!testRoot) throw new Error('OLA_ELECTRON_IPC_TEST_ROOT_REQUIRED')
const userData = join(testRoot, 'user-data')
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)

async function receivedCount(window: BrowserWindow): Promise<number> {
  return (await window.webContents.executeJavaScript('window.__olaTestEvents.length')) as number
}

async function waitForReceivedCount(window: BrowserWindow, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await receivedCount(window)) === expected) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(
    `ELECTRON_WORKSPACE_EVENT_COUNT_MISMATCH: expected ${expected}, received ${await receivedCount(window)}`
  )
}

async function run(): Promise<void> {
  ipcMain.handle('test:workspace-register', (event, workspaceId: string) => {
    const window = getTrustedWorkspaceRegistrationWindow(event)
    if (!window) return { accepted: false }
    const version = beginWindowWorkspaceRegistration(window)
    return {
      accepted: registerWindowWorkspace(window, workspaceId, version, false),
      workspaceId
    }
  })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false
    }
  })
  await window.loadURL(
    `data:text/html,${encodeURIComponent('<!doctype html><body><iframe srcdoc="<p>child</p>"></iframe></body>')}`
  )
  const mainResult = (await window.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'local-personal')"
  )) as { accepted?: boolean }
  if (mainResult?.accepted !== true || getRegisteredWindowWorkspace(window) !== 'local-personal')
    throw new Error('ELECTRON_WORKSPACE_MAIN_FRAME_REJECTED')
  const childFrame = window.webContents.mainFrame.frames[0]
  if (!childFrame) throw new Error('ELECTRON_WORKSPACE_CHILD_FRAME_MISSING')
  const childResult = (await childFrame.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'team-a')"
  )) as { accepted?: boolean }
  if (childResult?.accepted !== false || getRegisteredWindowWorkspace(window) !== 'local-personal')
    throw new Error('ELECTRON_WORKSPACE_CHILD_FRAME_ACCEPTED')
  const other = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
  })
  await other.loadURL('data:text/html,%3C!doctype%20html%3E%3Cbody%3E')
  for (const target of [window, other]) {
    await target.webContents.executeJavaScript(
      "window.__olaTestEvents = []; require('electron').ipcRenderer.on('goal:updated:msgpack', () => window.__olaTestEvents.push(1)); true"
    )
  }
  const otherResult = (await other.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'team-a')"
  )) as { accepted?: boolean }
  if (otherResult?.accepted !== true) throw new Error('ELECTRON_WORKSPACE_SECOND_WINDOW_REJECTED')
  safeSendMessagePackToWorkspaceWindows('team-a', 'goal:updated', { workspaceId: 'team-a' })
  await waitForReceivedCount(other, 1)
  if ((await receivedCount(window)) !== 0)
    throw new Error('ELECTRON_WORKSPACE_EVENT_LEAKED_TO_PERSONAL_WINDOW')

  await window.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'team-a')"
  )
  safeSendMessagePackToWorkspaceWindows('team-a', 'goal:updated', { workspaceId: 'team-a' })
  await waitForReceivedCount(window, 1)
  await waitForReceivedCount(other, 2)

  await other.loadURL('data:text/html,%3C!doctype%20html%3E%3Cbody%3E')
  await other.webContents.executeJavaScript(
    "window.__olaTestEvents = []; require('electron').ipcRenderer.on('goal:updated:msgpack', () => window.__olaTestEvents.push(1)); true"
  )
  if (getRegisteredWindowWorkspace(other) !== null)
    throw new Error('ELECTRON_WORKSPACE_RELOAD_REGISTRATION_RETAINED')
  safeSendMessagePackToWorkspaceWindows('team-a', 'goal:updated', { workspaceId: 'team-a' })
  await waitForReceivedCount(window, 2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  if ((await receivedCount(other)) !== 0)
    throw new Error('ELECTRON_WORKSPACE_EVENT_LEAKED_AFTER_RELOAD')

  const teamBResult = (await other.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'team-b')"
  )) as { accepted?: boolean }
  if (teamBResult?.accepted !== true) throw new Error('ELECTRON_TEAM_B_REGISTRATION_REJECTED')
  safeSendMessagePackToWorkspaceWindows('team-b', 'goal:updated', { workspaceId: 'team-b' })
  await waitForReceivedCount(other, 1)
  if ((await receivedCount(window)) !== 2) throw new Error('ELECTRON_TEAM_B_EVENT_LEAKED_TO_TEAM_A')

  await window.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'team-b')"
  )
  safeSendMessagePackToWorkspaceWindows('team-a', 'goal:updated', { workspaceId: 'team-a' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  if ((await receivedCount(window)) !== 2 || (await receivedCount(other)) !== 1)
    throw new Error('ELECTRON_TEAM_A_EVENT_LEAKED_AFTER_SWITCH')
  safeSendMessagePackToWorkspaceWindows('team-b', 'goal:updated', { workspaceId: 'team-b' })
  await waitForReceivedCount(window, 3)
  await waitForReceivedCount(other, 2)

  await window.webContents.executeJavaScript(
    "require('electron').ipcRenderer.invoke('test:workspace-register', 'team-a')"
  )
  safeSendMessagePackToWorkspaceWindows('team-b', 'goal:updated', { workspaceId: 'team-b' })
  await waitForReceivedCount(other, 3)
  await new Promise((resolve) => setTimeout(resolve, 20))
  if ((await receivedCount(window)) !== 3)
    throw new Error('ELECTRON_TEAM_B_EVENT_LEAKED_AFTER_RETURN')
  safeSendMessagePackToWorkspaceWindows('team-a', 'goal:updated', { workspaceId: 'team-a' })
  await waitForReceivedCount(window, 4)
  if (getRegisteredWindowWorkspace(window) !== 'team-a')
    throw new Error('ELECTRON_TEAM_A_RETURN_REGISTRATION_MISSING')
  process.stdout.write('Electron workspace IPC frame and multi-window routing test passed\n')
  other.destroy()
  window.destroy()
}

void app
  .whenReady()
  .then(run)
  .then(
    () => app.quit(),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      app.exit(1)
    }
  )
