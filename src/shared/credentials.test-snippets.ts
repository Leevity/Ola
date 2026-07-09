// Compile-time sanity tests for the challenge detector and the
// non-auto-resolvable guarantee. These are not run at build time; they
// exist to make regressions visible when reading the file.
//
// To actually execute: import { runAllTests } and call it from a dev
// console. The repo does not have a test runner set up (per AGENTS.md).

import {
  detectChallenge,
  detectUnknownChallenge,
  snapshotFromHtml
} from './challenge-detector-shared'
import { NON_AUTO_RESOLVABLE_CHALLENGES, type ChallengeKind } from './credentials'

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[credentials sanity] ${message}`)
  }
}

export function runAllTests(): void {
  // 1. Every ChallengeKind appears in the non-auto-resolvable map.
  for (const kind of Object.keys(NON_AUTO_RESOLVABLE_CHALLENGES) as ChallengeKind[]) {
    expect(
      NON_AUTO_RESOLVABLE_CHALLENGES[kind] === false,
      `${kind} must be marked as non-auto-resolvable`
    )
  }

  // 2. reCAPTCHA v2 detection.
  {
    const html = `
      <html><body>
        <form>
          <input type="text" name="email" />
          <div class="g-recaptcha" data-sitekey="xxx"></div>
          <button type="submit">Sign in</button>
        </form>
      </body></html>
    `
    const page = snapshotFromHtml('https://example.com/login', html)
    const challenge = detectChallenge(page)
    expect(challenge?.kind === 'recaptcha_v2', 'recaptcha_v2 should be detected')
  }

  // 3. hCaptcha detection.
  {
    const html = `<html><body><div class="h-captcha" data-sitekey="xxx"></div></body></html>`
    const page = snapshotFromHtml('https://example.com/login', html)
    expect(detectChallenge(page)?.kind === 'hcaptcha', 'hcaptcha should be detected')
  }

  // 4. Turnstile detection.
  {
    const html = `<html><body><div class="cf-turnstile" data-sitekey="xxx"></div></body></html>`
    const page = snapshotFromHtml('https://example.com/login', html)
    expect(detectChallenge(page)?.kind === 'turnstile', 'turnstile should be detected')
  }

  // 5. Cloudflare challenge URL detection.
  {
    const html = `<html><body>Checking your browser...</body></html>`
    const page = snapshotFromHtml('https://example.com/cdn-cgi/challenge', html)
    expect(
      detectChallenge(page)?.kind === 'device_fingerprint',
      'cf challenge page should be flagged'
    )
  }

  // 6. No challenge returns null.
  {
    const html = `<html><body><form><input type="email" /><input type="password" /><button type="submit">Go</button></form></body></html>`
    const page = snapshotFromHtml('https://example.com/login', html)
    expect(detectChallenge(page) === null, 'plain login form should not be flagged')
    expect(detectUnknownChallenge(page) === null, 'plain login form should not be flagged unknown')
  }

  // 7. Phone verification text.
  {
    const html = `<html><body><p>Enter the code we sent to your phone</p></body></html>`
    const page = snapshotFromHtml('https://example.com/2fa', html)
    expect(
      detectChallenge(page)?.kind === 'phone_verification',
      'phone verification text should be detected'
    )
  }

  // 8. All returned challenges are non-auto-resolvable.
  //    The shared DetectedChallenge type uses mapped-type spread
  //    (NON_AUTO_RESOLVABLE_CHALLENGES) so the literal `autoResolvable`
  //    property isn't visible to TS; we read it via a runtime cast.
  for (const html of [
    '<div class="g-recaptcha"></div>',
    '<div class="h-captcha"></div>',
    '<div class="cf-turnstile"></div>',
    '<p>Enter the code we sent to your phone</p>',
    '<p>verification code sent to your email</p>'
  ]) {
    const page = snapshotFromHtml('https://example.com/', html)
    const c = detectChallenge(page)
    if (c) {
      const value = (c as unknown as Record<string, unknown>).autoResolvable
      expect(value === false, `challenge ${c.kind} must NOT be auto-resolvable`)
    }
  }
}

// Auto-run when this module is evaluated in a dev console.
if (typeof window !== 'undefined') {
  try {
    runAllTests()
    console.info('[credentials sanity] all tests passed')
  } catch (error) {
    console.error('[credentials sanity] FAILED', error)
  }
}
