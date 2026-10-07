import { realpath } from 'node:fs/promises'
import type { RunSpec } from '../../shared/runtime/contracts'
import { RuntimeError } from '../../shared/runtime/contracts'
import { scenarioAllowsTool, type ScenarioPolicy } from '../../shared/scenario-policy'

export interface ScenarioSessionPolicy {
  scenario_policy: ScenarioPolicy | null
  working_folder: string | null
  ssh_connection_id: string | null
}

/** The persisted session, not Renderer input, selects the scenario tool boundary. */
export async function assertScenarioToolPolicy(
  run: RunSpec,
  session: ScenarioSessionPolicy | null
): Promise<void> {
  if (!session?.scenario_policy) return
  const policy = session.scenario_policy
  if (
    policy !== 'project-read-only' &&
    policy !== 'ssh-read-only' &&
    policy !== 'materials-no-tools'
  )
    throw new RuntimeError('SCENARIO_POLICY_INVALID')
  if (run.toolNames?.some((name) => !scenarioAllowsTool(policy, name)))
    throw new RuntimeError('SCENARIO_TOOL_FORBIDDEN')
  if (policy === 'materials-no-tools') return
  if (policy === 'project-read-only') {
    if (run.sshConnectionId || !run.workingDirectory || !session.working_folder)
      throw new RuntimeError('SCENARIO_PROJECT_MISMATCH')
    const [requestedRoot, sessionRoot] = await Promise.all([
      realpath(run.workingDirectory).catch(() => {
        throw new RuntimeError('SCENARIO_PROJECT_MISMATCH')
      }),
      realpath(session.working_folder).catch(() => {
        throw new RuntimeError('SCENARIO_PROJECT_MISMATCH')
      })
    ])
    if (
      process.platform === 'win32'
        ? requestedRoot.toLowerCase() !== sessionRoot.toLowerCase()
        : requestedRoot !== sessionRoot
    )
      throw new RuntimeError('SCENARIO_PROJECT_MISMATCH')
  } else if (
    !session.ssh_connection_id ||
    run.sshConnectionId !== session.ssh_connection_id ||
    (run.workingDirectory ?? '').replace(/[\\/]+$/, '') !==
      (session.working_folder ?? '').replace(/[\\/]+$/, '')
  ) {
    throw new RuntimeError('SCENARIO_PROJECT_MISMATCH')
  }
}
