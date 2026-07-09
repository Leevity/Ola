// Built-in site profiles for the credential agent.
// Each profile describes the deterministic selectors and success indicator
// the orchestrator can use without inspecting the DOM itself.
//
// Notes:
// - Selectors are intentionally conservative (prefer id/aria where possible).
// - `successIndicator.type === 'url_contains'` is the most reliable check
//   because it survives most front-end framework upgrades.
// - If a site changes, the user can re-verify in the Settings → Credentials
//   page and the orchestrator will fall back to a manual run.

import type { SiteProfile } from '../../../../shared/credentials'

export const BUILTIN_SITE_TEMPLATES: SiteProfile[] = [
  // ---- Development ----
  {
    id: 'github',
    displayName: 'GitHub',
    category: 'dev',
    domain: 'github.com',
    loginUrl: 'https://github.com/login',
    usernameSelector: '#login_field',
    passwordSelector: '#password',
    submitSelector: 'input[type="submit"][name="commit"]',
    successIndicator: { type: 'selector_visible', value: 'header[role="banner"]' },
    twoFactorIndicator: 'text=Two-factor authentication',
    notes: '2FA commonly required.'
  },
  {
    id: 'gitlab',
    displayName: 'GitLab',
    category: 'dev',
    domain: 'gitlab.com',
    loginUrl: 'https://gitlab.com/users/sign_in',
    usernameSelector: '#user_login',
    passwordSelector: '#user_password',
    submitSelector: 'button[type="submit"][data-qa-selector="sign_in_button"]',
    successIndicator: { type: 'url_contains', value: 'gitlab.com' }
  },
  {
    id: 'bitbucket',
    displayName: 'Bitbucket',
    category: 'dev',
    domain: 'bitbucket.org',
    loginUrl: 'https://bitbucket.org/account/signin/',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'bitbucket.org' }
  },

  // ---- General ----
  {
    id: 'google',
    displayName: 'Google',
    category: 'general',
    domain: 'google.com',
    loginUrl: 'https://accounts.google.com/signin',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'myaccount.google.com' },
    knownChallenge: 'totp_required',
    notes: '2FA almost always required.'
  },
  {
    id: 'microsoft',
    displayName: 'Microsoft',
    category: 'general',
    domain: 'login.microsoftonline.com',
    loginUrl: 'https://login.microsoftonline.com/',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'input[type="submit"]',
    successIndicator: { type: 'url_not_contains', value: 'login.microsoftonline.com' }
  },

  // ---- Content ----
  {
    id: 'notion',
    displayName: 'Notion',
    category: 'content',
    domain: 'notion.so',
    loginUrl: 'https://www.notion.so/login',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'div[role="button"]:has-text("Continue"), button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'notion.so' }
  },
  {
    id: 'medium',
    displayName: 'Medium',
    category: 'content',
    domain: 'medium.com',
    loginUrl: 'https://medium.com/m/signin',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'medium.com' }
  },
  {
    id: 'substack',
    displayName: 'Substack',
    category: 'content',
    domain: 'substack.com',
    loginUrl: 'https://substack.com/sign-in',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_not_contains', value: '/sign-in' }
  },

  // ---- Design ----
  {
    id: 'figma',
    displayName: 'Figma',
    category: 'design',
    domain: 'figma.com',
    loginUrl: 'https://www.figma.com/login',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'figma.com' }
  },

  // ---- Collaboration ----
  {
    id: 'linear',
    displayName: 'Linear',
    category: 'collaboration',
    domain: 'linear.app',
    loginUrl: 'https://linear.app/login',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'linear.app' }
  },
  {
    id: 'slack',
    displayName: 'Slack',
    category: 'collaboration',
    domain: 'slack.com',
    loginUrl: 'https://slack.com/signin',
    usernameSelector: '#email',
    passwordSelector: '#password',
    submitSelector: '#signin_btn',
    successIndicator: { type: 'url_contains', value: 'app.slack.com' }
  },
  {
    id: 'discord',
    displayName: 'Discord',
    category: 'collaboration',
    domain: 'discord.com',
    loginUrl: 'https://discord.com/login',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'discord.com/channels' }
  },

  // ---- Deployment ----
  {
    id: 'vercel',
    displayName: 'Vercel',
    category: 'deployment',
    domain: 'vercel.com',
    loginUrl: 'https://vercel.com/login',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'vercel.com' }
  },
  {
    id: 'netlify',
    displayName: 'Netlify',
    category: 'deployment',
    domain: 'app.netlify.com',
    loginUrl: 'https://app.netlify.com/login',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'app.netlify.com' }
  },
  {
    id: 'cloudflare',
    displayName: 'Cloudflare',
    category: 'deployment',
    domain: 'dash.cloudflare.com',
    loginUrl: 'https://dash.cloudflare.com/login',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'input[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'dash.cloudflare.com' },
    knownChallenge: 'device_fingerprint',
    notes: 'Cloudflare bot checks may pause automation.'
  },

  // ---- Services ----
  {
    id: 'supabase',
    displayName: 'Supabase',
    category: 'services',
    domain: 'supabase.com',
    loginUrl: 'https://supabase.com/dashboard/sign-in',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'supabase.com/dashboard' }
  },
  {
    id: 'railway',
    displayName: 'Railway',
    category: 'services',
    domain: 'railway.app',
    loginUrl: 'https://railway.app/login',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'railway.app' }
  },

  // ---- Personal ----
  {
    id: 'onepassword',
    displayName: '1Password',
    category: 'personal',
    domain: '1password.com',
    loginUrl: 'https://start.1password.com/signin',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: '1password.com' },
    knownChallenge: 'totp_required'
  },

  // ---- Data ----
  {
    id: 'airtable',
    displayName: 'Airtable',
    category: 'data',
    domain: 'airtable.com',
    loginUrl: 'https://airtable.com/login',
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successIndicator: { type: 'url_contains', value: 'airtable.com' }
  },

  // ---- Spare slots for the user ----
  {
    id: 'custom1',
    displayName: 'Custom site 1',
    category: 'custom',
    domain: '',
    loginUrl: '',
    usernameSelector: '',
    passwordSelector: '',
    submitSelector: '',
    successIndicator: { type: 'url_contains', value: '' },
    notes: 'Edit this template and add your domain.'
  },
  {
    id: 'custom2',
    displayName: 'Custom site 2',
    category: 'custom',
    domain: '',
    loginUrl: '',
    usernameSelector: '',
    passwordSelector: '',
    submitSelector: '',
    successIndicator: { type: 'url_contains', value: '' },
    notes: 'Edit this template and add your domain.'
  }
]

export function findSiteProfileByDomain(domain: string): SiteProfile | null {
  const lower = domain.trim().toLowerCase()
  if (!lower) return null
  return (
    BUILTIN_SITE_TEMPLATES.find(
      (profile) => profile.domain && profile.domain.toLowerCase() === lower
    ) ?? null
  )
}

export function findSiteProfileById(id: string): SiteProfile | null {
  return BUILTIN_SITE_TEMPLATES.find((profile) => profile.id === id) ?? null
}

export function listEnabledTemplateIds(): string[] {
  // Templates that have a non-empty domain. Custom slots with empty domain
  // are still listed but the user must fill them in first.
  return BUILTIN_SITE_TEMPLATES.filter((profile) => profile.domain.trim().length > 0).map(
    (profile) => profile.id
  )
}
