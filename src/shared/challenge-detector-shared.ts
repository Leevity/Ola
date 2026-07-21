// Shared challenge detector: safe to import from both main and renderer.
// Compiled to TypeScript and tree-shakable. No DOM dependency.
//
// Compile-time guarantee: every challenge kind is non-auto-resolvable.
// See NON_AUTO_RESOLVABLE_CHALLENGES in shared/credentials.ts.

import {
  NON_AUTO_RESOLVABLE_CHALLENGES,
  type ChallengeKind,
  type DetectedChallenge
} from './credentials'

export interface PageSnapshot {
  url: string
  html: string
  textContent: string
  hasSelector(selector: string): boolean
}

function makeHasSelector(html: string): (selector: string) => boolean {
  return (selector: string): boolean => {
    const sel = selector.trim()
    if (!sel) return false
    if (sel.startsWith('text=')) {
      const needle = sel.slice(5).toLowerCase()
      return html.toLowerCase().includes(needle)
    }
    if (sel.startsWith('iframe[src*="')) {
      const needle = sel.slice('iframe[src*="'.length, -2)
      return html.includes(needle)
    }
    if (sel.startsWith('[class*="')) {
      const needle = sel.slice('[class*="'.length, -2)
      return html.includes(needle)
    }
    if (sel.startsWith('.')) {
      return new RegExp(`class=["'][^"']*\\b${escapeRegExp(sel.slice(1))}\\b`).test(html)
    }
    if (sel.startsWith('#')) {
      return new RegExp(`id=["']${escapeRegExp(sel.slice(1))}["']`).test(html)
    }
    return html.includes(sel)
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function snapshotFromHtml(url: string, html: string): PageSnapshot {
  const lower = html.toLowerCase()
  const stripped = lower
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
  return {
    url,
    html: lower,
    textContent: stripped,
    hasSelector: makeHasSelector(lower)
  }
}

function report(kind: ChallengeKind, evidence: string): DetectedChallenge {
  return {
    kind,
    detectedAt: Date.now(),
    evidence,
    autoResolvable: NON_AUTO_RESOLVABLE_CHALLENGES[kind]
  }
}

export function detectChallenge(snapshot: PageSnapshot): DetectedChallenge | null {
  if (
    snapshot.hasSelector('iframe[src*="recaptcha/api2/anchor"]') ||
    snapshot.hasSelector('iframe[src*="recaptcha/api2/bframe"]') ||
    snapshot.hasSelector('.g-recaptcha')
  ) {
    return report('recaptcha_v2', 'recaptcha/api2 iframe or .g-recaptcha')
  }
  if (
    snapshot.hasSelector('.grecaptcha-badge') &&
    snapshot.textContent.includes("i'm not a robot")
  ) {
    return report('recaptcha_v3', '.grecaptcha-badge + "I am not a robot" text')
  }
  if (snapshot.hasSelector('iframe[src*="hcaptcha.com"]') || snapshot.hasSelector('.h-captcha')) {
    return report('hcaptcha', 'hcaptcha.com iframe or .h-captcha')
  }
  if (
    snapshot.hasSelector('iframe[src*="challenges.cloudflare.com"]') ||
    snapshot.hasSelector('.cf-turnstile')
  ) {
    return report('turnstile', 'challenges.cloudflare.com iframe or .cf-turnstile')
  }
  if (
    snapshot.hasSelector('[class*="slider"]') &&
    (snapshot.hasSelector('[class*="puzzle"]') ||
      snapshot.hasSelector('[class*="drag"]') ||
      snapshot.textContent.includes('drag the slider'))
  ) {
    return report('slider_puzzle', 'slider + puzzle/drag elements')
  }
  if (
    snapshot.url.includes('/cdn-cgi/challenge') ||
    snapshot.url.includes('challenge-platform') ||
    snapshot.hasSelector('#cf-challenge-running') ||
    snapshot.hasSelector('#challenge-stage')
  ) {
    return report('device_fingerprint', snapshot.url)
  }
  if (
    snapshot.textContent.includes('two-factor authentication') ||
    snapshot.textContent.includes('authenticate using your passkey') ||
    snapshot.textContent.includes('verification code from your authenticator app') ||
    snapshot.textContent.includes('enter your two-factor authentication code')
  ) {
    return report('totp_required', 'two-factor/passkey authentication text')
  }
  if (snapshot.textContent.includes('enter the code we sent to your phone')) {
    return report('phone_verification', 'phone verification text')
  }
  if (
    snapshot.textContent.includes('verification code sent to your email') ||
    snapshot.textContent.includes('enter the verification code sent to')
  ) {
    return report('email_verification', 'email verification text')
  }
  return null
}

export function detectUnknownChallenge(snapshot: PageSnapshot): DetectedChallenge | null {
  const hasCanvas = /<canvas\b/i.test(snapshot.html)
  const hasChallengeScript =
    snapshot.html.includes('challenge') && /<script\b[^>]*src=/.test(snapshot.html)
  if (hasCanvas && hasChallengeScript) {
    return report('unknown_challenge', 'suspicious canvas + challenge script')
  }
  return null
}
