import type { AccountGateway } from '../../shared/runtime/host'
import { openManagedModelRequest } from '../remote/account-client'

/**
 * The only desktop adapter from the TS runtime contract to account storage.
 * `account-client` retains the login token and obtains a fresh short-lived
 * model ticket for each request; callers receive only the response stream.
 */
export const mainAccountGateway: AccountGateway = {
  async openManagedModelRequest(input): Promise<Response> {
    return await openManagedModelRequest(input)
  }
}
