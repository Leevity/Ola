// CredentialAgent (renderer-side facade)
//
// All password plaintext flows main → vault. The renderer only sees
// CredentialRef (id + metadata) and VerificationResult metadata. The
// renderer never holds or persists plaintext passwords.

import { IPC } from '../ipc/channels'
import { ipcClient } from '../ipc/ipc-client'
import {
  CREDENTIALS_IPC,
  type BuiltinTemplateInfo,
  type CredentialRef,
  type DeleteCredentialRequest,
  type DeleteCredentialResponse,
  type EnableBuiltinTemplateRequest,
  type EnableBuiltinTemplateResponse,
  type ListBuiltinTemplatesResponse,
  type ListCredentialsFilter,
  type ListCredentialsResponse,
  type RecordCredentialVerificationRequest,
  type RecordCredentialVerificationResponse,
  type StoreCredentialRequest,
  type StoreCredentialResponse,
  type VaultStatus
} from '../../../../shared/credentials'

export interface AddCredentialInput {
  domain: string
  username: string
  password: string
  builtinTemplateId?: string
  notes?: string
  projectId?: string
  verify?: boolean
}

export interface EnableTemplateInput {
  templateId: string
  username: string
  password: string
  verify?: boolean
}

export class CredentialAgent {
  async getVaultStatus(): Promise<VaultStatus> {
    return (await ipcClient.invoke(IPC.CREDENTIALS_VAULT_STATUS)) as VaultStatus
  }

  async list(filter?: ListCredentialsFilter): Promise<CredentialRef[]> {
    const res = (await ipcClient.invoke(
      IPC.CREDENTIALS_LIST,
      filter ?? {}
    )) as ListCredentialsResponse
    return res.refs ?? []
  }

  async add(input: AddCredentialInput): Promise<StoreCredentialResponse> {
    const payload: StoreCredentialRequest = {
      domain: input.domain.trim(),
      username: input.username.trim(),
      password: input.password,
      builtinTemplateId: input.builtinTemplateId,
      notes: input.notes,
      verify: input.verify
    }
    return (await ipcClient.invoke(IPC.CREDENTIALS_STORE, payload)) as StoreCredentialResponse
  }

  async delete(id: string): Promise<DeleteCredentialResponse> {
    const payload: DeleteCredentialRequest = { id }
    return (await ipcClient.invoke(IPC.CREDENTIALS_DELETE, payload)) as DeleteCredentialResponse
  }

  async listBuiltinTemplates(): Promise<BuiltinTemplateInfo[]> {
    const res = (await ipcClient.invoke(
      IPC.CREDENTIALS_LIST_TEMPLATES,
      {}
    )) as ListBuiltinTemplatesResponse
    return res.templates ?? []
  }

  async enableBuiltinTemplate(input: EnableTemplateInput): Promise<EnableBuiltinTemplateResponse> {
    const payload: EnableBuiltinTemplateRequest = {
      templateId: input.templateId,
      username: input.username.trim(),
      password: input.password,
      verify: input.verify
    }
    return (await ipcClient.invoke(
      IPC.CREDENTIALS_ENABLE_TEMPLATE,
      payload
    )) as EnableBuiltinTemplateResponse
  }

  async recordVerification(
    id: string,
    result: RecordCredentialVerificationRequest['result']
  ): Promise<RecordCredentialVerificationResponse> {
    const payload: RecordCredentialVerificationRequest = { id, result }
    return (await ipcClient.invoke(
      IPC.CREDENTIALS_RECORD_VERIFICATION,
      payload
    )) as RecordCredentialVerificationResponse
  }
}

export const credentialAgent = new CredentialAgent()

// Re-export the IPC channel constants so other modules in the renderer can
// avoid the dependency on shared/credentials directly.
export { CREDENTIALS_IPC }
