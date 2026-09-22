import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateCommandSyntax } from '../../src/shared/security/command-policy'
import { resolveWorkspacePath } from '../../src/shared/security/path-policy'

describe('capability resource guards', () => {
  it('rejects lexical workspace escapes', () => {
    expect(resolveWorkspacePath('C:/workspace', '../outside').allowed).toBe(false)
    expect(resolveWorkspacePath('C:/workspace', 'src/index.ts').allowed).toBe(true)
  })

  it('rejects real-path symlink escape on non-Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'ola-ws-'))
    writeFileSync(join(root, 'inside.txt'), 'ok')
    expect(resolveWorkspacePath(root, 'inside.txt').allowed).toBe(true)
    expect(resolveWorkspacePath(root, 'does-not-exist.txt').allowed).toBe(true)
  })

  it('rejects compound and redirected commands before policy evaluation', () => {
    expect(evaluateCommandSyntax('git status').allowed).toBe(true)
    expect(evaluateCommandSyntax('git status && whoami').allowed).toBe(false)
    expect(evaluateCommandSyntax('type secret.txt > out.txt').allowed).toBe(false)
  })
})
