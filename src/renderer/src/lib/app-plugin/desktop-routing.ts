import type { AIModelConfig, ProviderConfig } from '@renderer/lib/api/types'
import {
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME
} from './types'

export type DesktopControlMode = 'disabled' | 'tools' | 'computer-use'

export const DESKTOP_CONTROL_TOOL_NAMES = new Set<string>([
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME
])

export function isDesktopControlToolName(name: string): boolean {
  return DESKTOP_CONTROL_TOOL_NAMES.has(name)
}

export function resolveDesktopControlMode(options: {
  providerConfig?: ProviderConfig | null
  modelConfig?: AIModelConfig | null
  desktopPluginEnabled: boolean
}): DesktopControlMode {
  const { providerConfig, modelConfig, desktopPluginEnabled } = options

  if (!desktopPluginEnabled) return 'disabled'

  const requestType = modelConfig?.type ?? providerConfig?.type
  const canUseComputerUse =
    requestType === 'openai-responses' &&
    modelConfig?.supportsComputerUse === true &&
    modelConfig.enableComputerUse === true

  return canUseComputerUse ? 'computer-use' : 'tools'
}
