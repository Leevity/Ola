export type UserFacingErrorAction =
  | 'openProvider'
  | 'openModel'
  | 'openSystem'
  | 'refreshStatus'
  | null

export interface UserFacingErrorExplanation {
  messageKey: string | null
  action: UserFacingErrorAction
}

/** Converts known technical failures into localized, actionable copy. */
export function explainUserFacingError(
  errorType: string | undefined,
  message: string
): UserFacingErrorExplanation {
  const haystack = `${errorType ?? ''} ${message}`.toLowerCase()
  if (/ola model|sign in to ola/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageOlaUnavailable', action: 'openModel' }
  }
  if (errorType === 'stream_recovery_unavailable') {
    return {
      messageKey: 'assistantMessage.agentError.messageStreamRecovery',
      action: 'refreshStatus'
    }
  }
  if (/ts_runtime|ts-runtime|local agent runtime/.test(haystack)) {
    return {
      messageKey: 'assistantMessage.agentError.messageRuntimeUnavailable',
      action: 'openSystem'
    }
  }
  if (/unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication|401|403/.test(haystack)) {
    return {
      messageKey: 'assistantMessage.agentError.messageAuthentication',
      action: 'openProvider'
    }
  }
  if (/no ai provider|no enabled provider|provider.*not configured/.test(haystack)) {
    return {
      messageKey: 'assistantMessage.agentError.messageProviderMissing',
      action: 'openProvider'
    }
  }
  if (/no ai model|no enabled model|model.*not configured/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageModelMissing', action: 'openModel' }
  }
  if (
    /insufficient.*(balance|quota|credit)|balance.*(insufficient|exhausted)|out of credits/.test(
      haystack
    )
  ) {
    return { messageKey: 'assistantMessage.agentError.messageBalance', action: 'openProvider' }
  }
  if (/rate limit|too many requests|\b429\b/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageRateLimit', action: null }
  }
  if (/timeout|timed out|etimedout|aborterror/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageTimeout', action: 'refreshStatus' }
  }
  if (/\b5\d\d\b|upstream.*(error|unavailable)|bad gateway|service unavailable/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageUpstream', action: null }
  }
  if (/bad request|invalid request|validation error|unprocessable|\b400\b|\b422\b/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageRequestInvalid', action: 'openModel' }
  }
  if (/tool.*(failed|error)|tool_error/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageToolFailed', action: null }
  }
  if (/econnrefused|enotfound|network|fetch failed|socket|dns|tls|ssl/.test(haystack)) {
    return { messageKey: 'assistantMessage.agentError.messageNetwork', action: 'openSystem' }
  }
  return { messageKey: null, action: null }
}
