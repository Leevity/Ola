import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

let database
try {
  database = new DatabaseSync(workerData.path)
  chmodSync(workerData.path, 0o600)
  database.exec(
    'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS runtime_lease (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;'
  )
  parentPort.postMessage({ ready: true })
  parentPort.on('message', () => {
    database.exec('ROLLBACK')
    database.close()
    parentPort.close()
  })
} catch {
  database?.close()
  parentPort.postMessage({ error: 'RUNTIME_DATA_LOCKED' })
  parentPort.close()
}
