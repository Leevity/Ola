/**
 * Names of the capabilities a run left out, in the user's words. A tool that has no entry here
 * would be dropped silently, so the catalog coverage test fails whenever the runtime's quarantine
 * list and this map diverge.
 */
export const RUN_CAPABILITY_LABEL_KEYS: Record<string, string> = {
  CanvasOperation: 'runCapability.canvas',
  GenerateVideo: 'runCapability.video',
  codegraph_explore: 'runCapability.codegraph',
  DesktopScreenshot: 'runCapability.desktop',
  DesktopClick: 'runCapability.desktop',
  DesktopType: 'runCapability.desktop',
  DesktopScroll: 'runCapability.desktop',
  DesktopWait: 'runCapability.desktop'
}

export function runCapabilityLabels(
  toolNames: readonly string[],
  translate: (key: string) => string
): string[] {
  return [
    ...new Set(
      toolNames
        .map((name) => RUN_CAPABILITY_LABEL_KEYS[name])
        .filter((key): key is string => Boolean(key))
        .map((key) => translate(key))
    )
  ]
}
