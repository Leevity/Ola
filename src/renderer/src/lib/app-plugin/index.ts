import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { desktopClickTool } from './desktop-click-tool'
import { desktopScreenshotTool } from './desktop-screenshot-tool'
import { desktopScrollTool } from './desktop-scroll-tool'
import { desktopTypeTool } from './desktop-type-tool'
import { desktopWaitTool } from './desktop-wait-tool'
import { imageGenerateTool } from './image-tool'
import {
  registerBrowserTool,
  unregisterBrowserTool,
  isBrowserToolRegistered
} from '../tools/browser-tool'
import { registerCodeGraphTool, unregisterCodeGraphTool } from '../tools/codegraph-tool'
import { agentBridge } from '../ipc/agent-bridge'
import {
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME,
  IMAGE_GENERATE_TOOL_NAME
} from './types'

let imageToolRegistered = false
let desktopControlToolsRegistered = false
let codeGraphWasEnabled = false

export function registerImagePluginTools(): void {
  if (imageToolRegistered) return
  toolRegistry.register(imageGenerateTool, {
    namespace: 'plugin',
    owner: 'core',
    capability: { riskLevel: 'medium', projectScoped: true }
  })
  imageToolRegistered = true
}

export function unregisterImagePluginTools(): void {
  if (!imageToolRegistered) return
  toolRegistry.unregister(IMAGE_GENERATE_TOOL_NAME)
  imageToolRegistered = false
}

export function registerDesktopControlTools(): void {
  if (desktopControlToolsRegistered) return
  for (const handler of [
    desktopScreenshotTool,
    desktopClickTool,
    desktopTypeTool,
    desktopScrollTool,
    desktopWaitTool
  ]) {
    toolRegistry.register(handler, {
      namespace: 'plugin',
      owner: 'core',
      capability: {
        readOnly: handler === desktopScreenshotTool,
        riskLevel: handler === desktopScreenshotTool ? 'medium' : 'high',
        projectScoped: false
      }
    })
  }
  desktopControlToolsRegistered = true
}

export function unregisterDesktopControlTools(): void {
  if (!desktopControlToolsRegistered) return
  toolRegistry.unregister(DESKTOP_SCREENSHOT_TOOL_NAME)
  toolRegistry.unregister(DESKTOP_CLICK_TOOL_NAME)
  toolRegistry.unregister(DESKTOP_TYPE_TOOL_NAME)
  toolRegistry.unregister(DESKTOP_SCROLL_TOOL_NAME)
  toolRegistry.unregister(DESKTOP_WAIT_TOOL_NAME)
  desktopControlToolsRegistered = false
}

export function isAppPluginToolsRegistered(): boolean {
  return (
    imageToolRegistered ||
    desktopControlToolsRegistered ||
    isBrowserToolRegistered() ||
    codeGraphWasEnabled
  )
}

export function updateAppPluginToolRegistration(): void {
  const store = useAppPluginStore.getState()

  if (store.isImageToolAvailable()) {
    registerImagePluginTools()
  } else {
    unregisterImagePluginTools()
  }

  if (store.isBrowserToolAvailable()) {
    registerBrowserTool()
  } else {
    unregisterBrowserTool()
  }

  if (store.isDesktopControlToolAvailable()) {
    registerDesktopControlTools()
  } else {
    unregisterDesktopControlTools()
  }

  if (store.isCodeGraphToolAvailable()) {
    registerCodeGraphTool()
    codeGraphWasEnabled = true
  } else {
    unregisterCodeGraphTool()
    if (codeGraphWasEnabled) {
      codeGraphWasEnabled = false
      void agentBridge.stopCodeGraph().catch((error) => {
        console.warn('[CodeGraph] failed to stop the disabled TS service:', error)
      })
    }
  }
}
