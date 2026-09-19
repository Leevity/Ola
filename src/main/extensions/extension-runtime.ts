import { join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { ConfigStore } from '../config/config-store'
import { EncryptedExtensionSecretStore } from './extension-secret-store'
import { ExtensionService } from './extension-service'
import { ExtensionStateStore } from './extension-state-store'
import { ExtensionStorageStore } from './extension-storage-store'

const olaDirectory = olaDataRoot()
const configStore = new ConfigStore(join(olaDirectory, 'config.json'))
const secrets = new EncryptedExtensionSecretStore(
  join(olaDirectory, 'extensions-secrets.bin'),
  undefined,
  {
    get: async (key) => await configStore.get(key),
    delete: async (key) => {
      const result = await configStore.delete(key)
      if (!result.success) throw new Error(result.error)
    }
  }
)

const extensionService = new ExtensionService(
  join(olaDirectory, 'extensions'),
  new ExtensionStateStore(join(olaDirectory, 'extensions.json')),
  secrets
)
const extensionStorage = new ExtensionStorageStore(join(olaDirectory, 'extensions-storage.json'))

export function getExtensionService(): ExtensionService {
  return extensionService
}

export function getExtensionStorage(): ExtensionStorageStore {
  return extensionStorage
}
