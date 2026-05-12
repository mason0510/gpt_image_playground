import type { ApiProfile, AppSettings, ResponsesApiResponse, TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage, MIME_MAP, normalizeBase64Image } from './imageApiShared'

export interface AgentApiMessage {
  role: 'user' | 'assistant'
  text: string
  imageDataUrls?: string[]
}

export interface AgentApiResultImage {
  dataUrl: string
  revisedPrompt?: string
}

export interface AgentApiResult {
  responseId?: string
  text: string
  images: AgentApiResultImage[]
  rawResponsePayload?: string
}

function createHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    'Content-Type': 'application/json',
  }
}

function createImageTool(params: TaskParams): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: 'auto',
    size: params.size,
    output_format: params.output_format,
  }

  tool.quality = params.quality

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  return tool
}

function createInput(messages: AgentApiMessage[]) {
  return messages.map((message) => {
    const content: Array<Record<string, string>> = [
      { type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text },
    ]

    if (message.role === 'user') {
      for (const dataUrl of message.imageDataUrls ?? []) {
        content.push({ type: 'input_image', image_url: dataUrl })
      }
    }

    return {
      role: message.role,
      content,
    }
  })
}

function extractText(payload: ResponsesApiResponse) {
  const chunks: string[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        chunks.push(part.text)
      }
    }
  }

  return chunks.join('\n').trim()
}

function extractImages(payload: ResponsesApiResponse, fallbackMime: string): AgentApiResultImage[] {
  const images: AgentApiResultImage[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'image_generation_call') continue

    const result = item.result
    if (typeof result === 'string' && result.trim()) {
      images.push({
        dataUrl: normalizeBase64Image(result, fallbackMime),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
      continue
    }

    if (result && typeof result === 'object') {
      const b64 = typeof result.b64_json === 'string'
        ? result.b64_json
        : typeof result.image === 'string'
        ? result.image
        : typeof result.data === 'string'
        ? result.data
        : ''
      if (b64.trim()) {
        images.push({
          dataUrl: normalizeBase64Image(b64, fallbackMime),
          revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
        })
      }
    }
  }

  return images
}

export async function callAgentResponsesApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  params: TaskParams
  messages: AgentApiMessage[]
}): Promise<AgentApiResult> {
  const { settings, profile, params, messages } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify({
        model: profile.model || settings.model,
        input: createInput(messages),
        tools: [createImageTool(params)],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    const payload = await response.json() as ResponsesApiResponse
    return {
      responseId: payload.id,
      text: extractText(payload),
      images: extractImages(payload, mime),
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
