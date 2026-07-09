// Shared, main-process-importable copy of the built-in site profile list.
// Kept in `shared/` so both the main process IPC handlers and the renderer
// can import the same canonical list.

import type { SiteProfile } from './credentials'

export const SHARED_BUILTIN_SITE_TEMPLATES: SiteProfile[] = [
  {
    id: 'github',
    displayName: 'GitHub',
    category: 'dev',
    domain: 'github.com',
    loginUrl: 'https://github.com/login',
    usernameSelector: '#login_field',
    passwordSelector: '#password',
    submitSelector: 'input[type="submit"][name="commit"]',
    successIndicator: { type: 'url_contains', value: 'github.com' },
    twoFactorIndicator: 'text=Two-factor authentication'
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
    knownChallenge: 'totp_required'
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
  {
    id: 'notion',
    displayName: 'Notion',
    category: 'content',
    domain: 'notion.so',
    loginUrl: 'https://www.notion.so/login',
    usernameSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"]',
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
    knownChallenge: 'device_fingerprint'
  },
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
  {
    id: 'custom1',
    displayName: 'Custom site 1',
    category: 'custom',
    domain: '',
    loginUrl: '',
    usernameSelector: '',
    passwordSelector: '',
    submitSelector: '',
    successIndicator: { type: 'url_contains', value: '' }
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
    successIndicator: { type: 'url_contains', value: '' }
  }
]

export function findSiteProfileById(id: string): SiteProfile | null {
  return SHARED_BUILTIN_SITE_TEMPLATES.find((profile) => profile.id === id) ?? null
}

export function findSiteProfileByDomain(domain: string): SiteProfile | null {
  const lower = domain.trim().toLowerCase()
  if (!lower) return null
  return (
    SHARED_BUILTIN_SITE_TEMPLATES.find(
      (profile) => profile.domain && profile.domain.toLowerCase() === lower
    ) ?? null
  )
}
