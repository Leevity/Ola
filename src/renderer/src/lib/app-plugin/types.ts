export const IMAGE_PLUGIN_ID = 'image' as const
export const BROWSER_PLUGIN_ID = 'browser' as const
export const PRODUCT_DESIGN_PLUGIN_ID = 'product-design' as const
export const DESKTOP_CONTROL_PLUGIN_ID = 'desktop-control' as const

export const IMAGE_GENERATE_TOOL_NAME = 'ImageGenerate' as const
export const BROWSER_NAVIGATE_TOOL_NAME = 'BrowserNavigate' as const
export const BROWSER_GET_CONTENT_TOOL_NAME = 'BrowserGetContent' as const
export const BROWSER_SCREENSHOT_TOOL_NAME = 'BrowserScreenshot' as const
export const BROWSER_SNAPSHOT_TOOL_NAME = 'BrowserSnapshot' as const
export const BROWSER_CLICK_TOOL_NAME = 'BrowserClick' as const
export const BROWSER_TYPE_TOOL_NAME = 'BrowserType' as const
export const BROWSER_SCROLL_TOOL_NAME = 'BrowserScroll' as const
export const DESKTOP_SCREENSHOT_TOOL_NAME = 'DesktopScreenshot' as const
export const DESKTOP_CLICK_TOOL_NAME = 'DesktopClick' as const
export const DESKTOP_TYPE_TOOL_NAME = 'DesktopType' as const
export const DESKTOP_SCROLL_TOOL_NAME = 'DesktopScroll' as const
export const DESKTOP_WAIT_TOOL_NAME = 'DesktopWait' as const

export type AppPluginId =
  | typeof IMAGE_PLUGIN_ID
  | typeof BROWSER_PLUGIN_ID
  | typeof PRODUCT_DESIGN_PLUGIN_ID
  | typeof DESKTOP_CONTROL_PLUGIN_ID
export type AppPluginToolName =
  | typeof IMAGE_GENERATE_TOOL_NAME
  | typeof BROWSER_NAVIGATE_TOOL_NAME
  | typeof BROWSER_GET_CONTENT_TOOL_NAME
  | typeof BROWSER_SCREENSHOT_TOOL_NAME
  | typeof BROWSER_SNAPSHOT_TOOL_NAME
  | typeof BROWSER_CLICK_TOOL_NAME
  | typeof BROWSER_TYPE_TOOL_NAME
  | typeof BROWSER_SCROLL_TOOL_NAME
  | typeof DESKTOP_SCREENSHOT_TOOL_NAME
  | typeof DESKTOP_CLICK_TOOL_NAME
  | typeof DESKTOP_TYPE_TOOL_NAME
  | typeof DESKTOP_SCROLL_TOOL_NAME
  | typeof DESKTOP_WAIT_TOOL_NAME

export function isAppPluginEnabledByDefault(id: AppPluginId): boolean {
  if (id === DESKTOP_CONTROL_PLUGIN_ID) return false
  return true
}

export interface AppPluginDescriptor {
  id: AppPluginId
  builtin: true
  toolNames: AppPluginToolName[]
  requiresModelConfig: boolean
  hidden?: boolean
}

export interface AppPluginInstance {
  id: AppPluginId
  enabled: boolean
  useGlobalModel: boolean
  providerId: string | null
  modelId: string | null
  browserAllowedDomains?: string[]
  browserBlockedDomains?: string[]
}

export const APP_PLUGIN_DESCRIPTORS: AppPluginDescriptor[] = [
  {
    id: IMAGE_PLUGIN_ID,
    builtin: true,
    toolNames: [IMAGE_GENERATE_TOOL_NAME],
    requiresModelConfig: true
  },
  {
    id: BROWSER_PLUGIN_ID,
    builtin: true,
    toolNames: [
      BROWSER_NAVIGATE_TOOL_NAME,
      BROWSER_GET_CONTENT_TOOL_NAME,
      BROWSER_SCREENSHOT_TOOL_NAME,
      BROWSER_SNAPSHOT_TOOL_NAME,
      BROWSER_CLICK_TOOL_NAME,
      BROWSER_TYPE_TOOL_NAME,
      BROWSER_SCROLL_TOOL_NAME
    ],
    requiresModelConfig: false
  },
  {
    id: PRODUCT_DESIGN_PLUGIN_ID,
    builtin: true,
    toolNames: [],
    requiresModelConfig: false
  },
  {
    id: DESKTOP_CONTROL_PLUGIN_ID,
    builtin: true,
    toolNames: [
      DESKTOP_SCREENSHOT_TOOL_NAME,
      DESKTOP_CLICK_TOOL_NAME,
      DESKTOP_TYPE_TOOL_NAME,
      DESKTOP_SCROLL_TOOL_NAME,
      DESKTOP_WAIT_TOOL_NAME
    ],
    requiresModelConfig: false,
    hidden: true
  }
]
