export type { BuiltinProviderPreset } from './types'

import { openaiPreset } from './openai'
import { anthropicPreset } from './anthropic'
import { longcatPreset } from './longcat'
import { googlePreset } from './google'
import { deepseekPreset } from './deepseek'
import { openrouterPreset } from './openrouter'
import { ollamaPreset } from './ollama'
import { azureOpenaiPreset } from './azure-openai'
import { moonshotCodingPreset, moonshotPreset } from './moonshot'
import { qwenCodingPreset, qwenPreset } from './qwen'
import { minimaxCodingPreset, minimaxPreset } from './minimax'
import { baiduCodingPreset, baiduPreset } from './baidu'
import { siliconflowPreset } from './siliconflow'
import { giteeAiPreset } from './gitee-ai'
import { codexOAuthPreset } from './codex-oauth'
import { copilotOAuthPreset } from './copilot-oauth'
import { xiaomiCodingPreset, xiaomiPreset } from './xiaomi'
import { bigmodelCodingPreset, bigmodelPreset } from './bigmodel'
import { volcenginePreset } from './volcengine'
import { xaiPreset } from './x-ai'
import { whalecloudPreset } from './whalecloud'
import type { BuiltinProviderPreset } from './types'

export const builtinProviderPresets: BuiltinProviderPreset[] = [
  openaiPreset,
  anthropicPreset,
  longcatPreset,
  googlePreset,
  deepseekPreset,
  openrouterPreset,
  ollamaPreset,
  azureOpenaiPreset,
  moonshotCodingPreset,
  moonshotPreset,
  qwenCodingPreset,
  qwenPreset,
  baiduCodingPreset,
  baiduPreset,
  minimaxCodingPreset,
  minimaxPreset,
  siliconflowPreset,
  giteeAiPreset,
  codexOAuthPreset,
  copilotOAuthPreset,
  xiaomiCodingPreset,
  xiaomiPreset,
  bigmodelCodingPreset,
  bigmodelPreset,
  volcenginePreset,
  xaiPreset,
  whalecloudPreset
]
