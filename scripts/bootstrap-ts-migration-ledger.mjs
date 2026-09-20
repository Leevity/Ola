import { readFile, writeFile, access } from 'node:fs/promises'

const inventory = JSON.parse(
  await readFile(
    new URL('../docs/migrations/ts-runtime/capability-inventory.json', import.meta.url)
  )
)
const destination = new URL('../docs/migrations/ts-runtime/acceptance-ledger.json', import.meta.url)
try {
  await access(destination)
  throw new Error(
    'Acceptance ledger already exists; edit it deliberately instead of regenerating it'
  )
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const phases = [
  ['P0', '固定工作区、完整功能与数据基线'],
  ['P1', '旧新契约、行为、Electron E2E 与视觉基线'],
  ['P2', '桌面与 CLI 共用受保护的 TS 服务和单写入者'],
  ['P3', '离线空间、个人团队模型、账户网关与秘密边界'],
  ['P4', 'Agent 循环、协议、工具、Hooks、Skills、MCP 与审批'],
  ['P5', '所有入口统一调度、取消、重启恢复与副作用裁决'],
  ['P6', '其余业务服务和全部旧 Worker 路由迁移'],
  ['P7', '18 语言 CodeGraph、语义对照和性能门禁'],
  ['P8', '业务库停写、备份、TS 独占写入与恢复演练'],
  ['P9', '工作台、多窗口、标签、分屏和布局恢复'],
  ['P10', '对话和全部既有功能页验收'],
  ['P11', 'Main 浏览器生命周期、控制权和自动化'],
  ['P12', '删除全部 .NET、真实主站联调与六平台发布验收']
]
const routes = inventory.routes.map((route) => ({
  id: route.method,
  legacyEntrypoint: route.method,
  legacySource: route.source,
  inventoryHint: route.status,
  tsImplementation: null,
  productionCallPath: null,
  legacyPathRemoved: false,
  contractEvidence: [],
  e2eEvidence: [],
  status: '实现中'
}))
const languages = inventory.codegraphLanguages.map((language) => ({
  id: language.id,
  legacyLibrary: language.library,
  tsImplementation: null,
  semanticEvidence: [],
  incrementalEvidence: [],
  performanceEvidence: [],
  status: '实现中'
}))
const ledger = {
  schemaVersion: 1,
  authority: '用户提供的《Ola 全量 TS 迁移与体验优化方案——整合离线优先个人／团队工作空间设计》',
  baseline: 'worktree-baseline.json',
  statusValues: ['未开始', '实现中', '待验收', '通过', '受外部条件阻塞'],
  notes: [
    'inventoryHint 是旧源码静态字符串匹配结果，绝不是功能等价或生产切换证据。',
    '状态为通过时，所有必填证据与旧路径清理必须同时成立。',
    '验收仅以本台账和实际测试/产物证据为准；历史迁移日志属于过程记录。'
  ],
  phases: phases.map(([id, criterion]) => ({ id, criterion, evidence: [], status: '实现中' })),
  routes,
  codegraphLanguages: languages,
  releaseTargets: [
    'windows-x64',
    'windows-arm64',
    'linux-x64',
    'linux-arm64',
    'macos-x64',
    'macos-arm64'
  ].map((id) => ({
    id,
    buildEvidence: [],
    installEvidence: [],
    upgradeEvidence: [],
    launchEvidence: [],
    signingEvidence: [],
    noDotnetEvidence: [],
    status: '未开始'
  })),
  realSite: {
    personalAndTeamDirectoryEvidence: [],
    ticketAndStreamingEvidence: [],
    revokeAndFailureEvidence: [],
    status: '未开始'
  }
}
await writeFile(destination, JSON.stringify(ledger, null, 2) + '\n')
console.log(
  `Bootstrapped ${routes.length} route and ${languages.length} CodeGraph acceptance entries`
)
