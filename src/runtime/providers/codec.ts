import type { ModelDelta, ModelInput } from '../../shared/runtime/model'
import type { ModelRequest, ModelTarget } from './transport'
export interface ModelCodec {
  encode(input: ModelInput, target: ModelTarget): ModelRequest
  decode(response: Response, input: ModelInput, target: ModelTarget): AsyncIterable<ModelDelta>
}
