import type { ChatCompletionRequest, ChatCompletionResponse, ModelObject } from '../schemas/openai.js'

export interface BaseProvider {
  readonly name: string
  chatComplete(req: ChatCompletionRequest, upstream: string): Promise<ChatCompletionResponse>
  chatCompleteStream(req: ChatCompletionRequest, upstream: string): AsyncGenerator<string>
  listModels(): Promise<ModelObject[]>
  healthCheck(): Promise<boolean>
}
