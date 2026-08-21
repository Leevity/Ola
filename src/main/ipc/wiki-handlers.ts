import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProjectWikiGenerateRequest } from '../../shared/project-wiki'
import {
  generateProjectWiki,
  loadProjectWiki,
  writeProjectWikiMarkdown
} from '../wiki/wiki-service'
import { loadWikiDocument, saveWikiDocument } from '../db/capability-dao'

function isTrustedWikiIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

export function registerWikiHandlers(): void {
  ipcMain.handle('wiki:generate', async (event, args: ProjectWikiGenerateRequest) => {
    if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
    const document = generateProjectWiki(args)
    await saveWikiDocument(document)
    return document
  })
  ipcMain.handle('wiki:get', async (event, args: { projectRoot: string }) => {
    if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
    return (await loadWikiDocument(args.projectRoot)) ?? loadProjectWiki(args.projectRoot)
  })
  ipcMain.handle(
    'wiki:export',
    async (event, args: { projectRoot: string; destination: string }) => {
      if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
      const document =
        (await loadWikiDocument(args.projectRoot)) ??
        loadProjectWiki(args.projectRoot) ??
        generateProjectWiki({ projectRoot: args.projectRoot })
      await saveWikiDocument(document)
      writeProjectWikiMarkdown(document, args.destination)
      return { success: true, destination: args.destination }
    }
  )
}
