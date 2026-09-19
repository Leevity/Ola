import { spawn } from 'node:child_process'

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Runtime CLI terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

const buildExitCode = await execute(process.execPath, ['scripts/build-ts-runtime.mjs'])
if (buildExitCode !== 0) process.exitCode = buildExitCode
else
  process.exitCode = await execute(process.execPath, [
    'out/runtime/cli.mjs',
    ...process.argv.slice(2)
  ])
