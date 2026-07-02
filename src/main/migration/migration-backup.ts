import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const DATA_DIR = path.join(os.homedir(), '.ola')

function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

function toBackupRelativePath(filePath: string): string {
  const relative = path.relative(DATA_DIR, filePath)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative
  }
  return path.basename(filePath)
}

export function createMigrationBackup(source: string, filePaths: string[]): string | undefined {
  const existingFiles = Array.from(new Set(filePaths.filter((filePath) => fs.existsSync(filePath))))
  if (existingFiles.length === 0) return undefined

  const backupRoot = path.join(DATA_DIR, 'backups', 'migrations', `${source}-${formatTimestamp()}`)
  fs.mkdirSync(backupRoot, { recursive: true })

  const copiedFiles: Array<{ source: string; backup: string }> = []

  for (const filePath of existingFiles) {
    const relativePath = toBackupRelativePath(filePath)
    const backupPath = path.join(backupRoot, relativePath)
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.copyFileSync(filePath, backupPath)
    copiedFiles.push({ source: filePath, backup: backupPath })
  }

  fs.writeFileSync(
    path.join(backupRoot, 'manifest.json'),
    JSON.stringify(
      {
        source,
        createdAt: new Date().toISOString(),
        files: copiedFiles
      },
      null,
      2
    ),
    'utf-8'
  )

  return backupRoot
}
