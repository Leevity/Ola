import { describe, expect, it } from 'vitest'
import { normalizeSshConfigDocument } from '../../src/main/ssh/ssh-config-json'
import { applySshImportPreview } from '../../src/main/ssh/ssh-import-ola'
import { parseKnownHosts, previewOpenSshImport } from '../../src/main/ssh/ssh-import-openssh'

const current = normalizeSshConfigDocument({
  connections: [
    {
      id: 'existing',
      name: 'Previous',
      host: 'box.invalid',
      username: 'alice',
      password: 'local-password',
      passphrase: 'local-passphrase',
      startupCommand: 'echo ready',
      defaultDirectory: '/work',
      keepAliveInterval: 31,
      createdAt: 10,
      updatedAt: 10
    }
  ]
})

describe('TS OpenSSH import', () => {
  it('parses defaults, exact aliases, wildcard warnings and known_hosts', () => {
    const knownHosts = parseKnownHosts(
      '# comment\n|1|hashed|value ssh-ed25519 key\nbox.invalid,[other.invalid]:2222 ssh-ed25519 key\n'
    )
    expect(knownHosts.has('box.invalid')).toBe(true)
    expect(knownHosts.has('|1|hashed|value')).toBe(false)
    const preview = previewOpenSshImport(
      `Host missing
  HostName missing.invalid
Host *
  User alice
  Port 22
Include fragments/*.conf
Host box *.ignored !negative
  HostName box.invalid
  IdentityFile "~/.ssh/id_box"
  ProxyJump jump
Host new
  HostName other.invalid
  Port 2222
`,
      current,
      '/home/alice/.ssh/config',
      knownHosts,
      '/home/alice'
    )
    expect(preview.warnings).toContain('OpenSSH Include not yet supported: fragments/*.conf')
    expect(preview.warnings).toContain('Ignored wildcard Host pattern: *.ignored, !negative')
    expect(preview.warnings).toContain('Host missing missing User, skipped.')
    expect(preview.connections).toMatchObject([
      {
        importId: '1:box:box.invalid:22:alice',
        authType: 'privateKey',
        privateKeyPath: '/home/alice/.ssh/id_box',
        proxyJump: 'jump',
        hasKnownHost: true,
        conflictConnectionId: 'existing',
        defaultAction: 'skip'
      },
      {
        importId: '2:new:other.invalid:2222:alice',
        authType: 'agent',
        hasKnownHost: true,
        defaultAction: 'create'
      }
    ])
    expect(preview.connections[1].warnings).toContain(
      'IdentityFile not found, will default to SSH Agent authentication.'
    )
  })

  it('preserves local secret and startup fields when replacing an OpenSSH conflict', () => {
    const preview = previewOpenSshImport(
      'Host box\n  HostName box.invalid\n  User alice\n  IdentityFile ~/.ssh/id_new\n',
      current,
      '/home/alice/.ssh/config',
      new Set(),
      '/home/alice'
    )
    const applied = applySshImportPreview(
      current,
      preview,
      [{ importId: preview.connections[0].importId, action: 'replace' }],
      100
    )
    expect(applied.result).toMatchObject({ replaced: 1, imported: 0 })
    expect(applied.result.warnings).toContain(
      'Preserved box startup command, default directory, heartbeat and password fields.'
    )
    expect(applied.config.connections[0]).toMatchObject({
      id: 'existing',
      name: 'box',
      password: 'local-password',
      passphrase: 'local-passphrase',
      startupCommand: 'echo ready',
      defaultDirectory: '/work',
      keepAliveInterval: 31,
      privateKeyPath: '/home/alice/.ssh/id_new',
      createdAt: 10,
      updatedAt: 100
    })
  })
})
