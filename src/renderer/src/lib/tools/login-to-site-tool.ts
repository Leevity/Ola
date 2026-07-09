// LoginToSite: the credential agent's main entry point as a tool.
// Drives the full login flow for a given domain through the visible
// BrowserPanel state machine. Password injection still happens in main.
//
// Passwords are NEVER returned to the renderer.

import type { ToolHandler } from './tool-types'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import { credentialAgent } from '../credentials/credential-agent'
import { startLoginRun } from '../credentials/login-state-machine'
import type { LoginStatus } from '../../../../shared/credentials'
import type { ToolContext } from './tool-types'

const LOGIN_TO_SITE_TOOL_NAME = 'LoginToSite'

interface LoginArgs {
  domain: string
  purpose?: string
}

export const loginToSiteTool: ToolHandler = {
  definition: {
    name: LOGIN_TO_SITE_TOOL_NAME,
    description:
      'Log the user in to a given domain using a stored credential. ' +
      'Returns one of: logged_in, need_2fa, paused_for_challenge (a captcha/slider was detected and the user must take over), no_credential (no entry for this domain), failed.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain to log in to, e.g. "github.com".'
        },
        purpose: {
          type: 'string',
          description: 'Optional human-readable reason for this login attempt.'
        }
      },
      required: ['domain']
    }
  },
  execute: async (rawInput: unknown, ctx?: ToolContext) => {
    const args = (rawInput ?? {}) as LoginArgs
    if (!args.domain || typeof args.domain !== 'string') {
      return encodeToolError('"domain" is required')
    }
    // 1. Find a credential for this domain.
    const refs = await credentialAgent.list({ domain: args.domain })
    const ref = refs[0]
    if (!ref) {
      return encodeStructuredToolResult({
        status: 'no_credential' satisfies LoginStatus,
        reason: `No credential stored for ${args.domain}. The user can add one in Settings → Credentials.`
      })
    }
    const res = await startLoginRun({
      domain: ref.domain,
      credentialId: ref.id,
      username: ref.usernameHint ?? '',
      sessionId: ctx?.sessionId ?? null,
      projectId: null
    })
    if (res.status === 'paused_for_challenge' && res.challenge) {
      return encodeStructuredToolResult({
        status: 'paused_for_challenge' satisfies LoginStatus,
        challenge: res.challenge,
        reason: `Automation challenge (${res.challenge.kind}) detected. The user must complete the challenge manually in the browser panel; the agent should wait for the user to confirm.`
      })
    }
    if (res.status === 'logged_in') {
      return encodeStructuredToolResult({ status: 'logged_in' satisfies LoginStatus })
    }
    return encodeStructuredToolResult({
      status: res.status,
      reason: res.reason ?? 'login failed'
    })
  }
}

export { LOGIN_TO_SITE_TOOL_NAME }
