import type { LiveOutputAnimationStyle } from '@renderer/stores/settings-store'

export const LIVE_OUTPUT_ANIMATION_STYLES = ['agile', 'elegant'] as const

export function getLiveOutputDotClass(style: LiveOutputAnimationStyle): string {
  return `ai-live-dot ${style === 'elegant' ? 'ai-live-dot--elegant' : 'ai-live-dot--agile'}`
}

export function getLiveOutputCursorClass(style: LiveOutputAnimationStyle): string {
  return `ai-live-cursor ${style === 'elegant' ? 'ai-live-cursor--elegant' : 'ai-live-cursor--agile'}`
}

export function getLiveOutputSurfaceClass(style: LiveOutputAnimationStyle): string {
  return `ai-live-stream ${
    style === 'elegant' ? 'ai-live-stream--elegant' : 'ai-live-stream--agile'
  }`
}

export function getLiveOutputComponentClass(style: LiveOutputAnimationStyle): string {
  return `ai-live-component ${
    style === 'elegant' ? 'ai-live-component--elegant' : 'ai-live-component--agile'
  }`
}

export function getLiveOutputThinkingClass(style: LiveOutputAnimationStyle): string {
  return `ai-live-thinking ${
    style === 'elegant' ? 'ai-live-thinking--elegant' : 'ai-live-thinking--agile'
  }`
}
