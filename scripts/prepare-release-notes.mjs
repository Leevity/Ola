import { readFileSync, writeFileSync } from 'node:fs'

const version = process.env.INPUT_VERSION
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid release version')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.version !== version) throw new Error('Release version must match source version')
const body = readFileSync(`docs/releases/${version}.md`, 'utf8')
if (!body.trim()) throw new Error('Release notes must not be empty')
const distribution =
  process.env.INPUT_UNSIGNED_BUILD === 'true'
    ? '\n\n发布构建模式：无发布证书签名；macOS 未经 Apple 公证，Windows 未经 Authenticode 签名。\n'
    : '\n\n发布构建模式：按平台签名配置执行，实际签名状态以构建检查结果为准。\n'
writeFileSync('release-notes.md', body + distribution)
