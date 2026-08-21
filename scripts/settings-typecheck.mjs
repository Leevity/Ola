import { spawn } from 'node:child_process'

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run typecheck:web']
    : ['run', 'typecheck:web']
const child = spawn(command, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
