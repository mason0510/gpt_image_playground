import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type CustomProviderDefinition, type CustomProviderPollMapping, type CustomProviderResultMapping, type CustomProviderSubmitMapping, type ImageApiResponse, type ImageResponseItem, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { tracedFetch } from './apiDebugTrace'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import { buildApiUrl, normalizeBaseUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { createApiAuthorizationHeaders, isLimitedFreeApiKey } from './apiKeyMode'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
  readJsonResponse,
} from './imageApiShared'

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

function getStreamPartialImages(profile: ApiProfile): number {
  return profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
}

function appendQuery(path: string, query?: Record<string, string>): string {
  if (!query || !Object.keys(query).length) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

function createOpenAICompatiblePaths(customProvider?: CustomProviderDefinition | null) {
  return {
    generationPath: 'images/generations',
    editPath: 'images/edits',
  }
}

function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  const parts = path.split('.').filter(Boolean)
  let current: unknown[] = [source]

  for (const key of parts) {
    const next: unknown[] = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
        continue
      }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }

  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

function normalizeImageApiPayload(value: unknown): ImageApiResponse {
  if (Array.isArray(value)) return { data: value as ImageApiResponse['data'] }
  if (value && typeof value === 'object') return value as ImageApiResponse
  return { data: [] }
}

function createRequestHeaders(profile: ApiProfile, useApiProxy: boolean): Record<string, string> {
  return createApiAuthorizationHeaders(profile.apiKey, useApiProxy)
}

function traceMeta(profile: ApiProfile, useApiProxy: boolean, label: string) {
  return { profile, useApiProxy, label }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? '流式请求失败'
  }
  return null
}

function parseServerSentEventBlock(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return null
  return data
}

const STOP_READING_SSE = Symbol('STOP_READING_SSE')

async function readJsonServerSentEvents(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void | typeof STOP_READING_SSE | Promise<void | typeof STOP_READING_SSE>,
): Promise<void> {
  if (!response.body) throw new Error('接口未返回可读取的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let shouldStop = false

  const processBlock = async (block: string) => {
    const data = parseServerSentEventBlock(block)
    if (!data) return

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('流式响应包含无法解析的 JSON 事件')
    }
    if (!isRecordValue(event)) return

    const errorMessage = getStreamEventErrorMessage(event)
    if (errorMessage) throw new Error(errorMessage)

    const result = await onEvent(event)
    if (result === STOP_READING_SSE) shouldStop = true
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.search(/\r?\n\r?\n/)
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex)
      const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
      buffer = buffer.slice(separatorIndex + separator.length)
      await processBlock(block)
      if (shouldStop) {
        await reader.cancel()
        return
      }
      separatorIndex = buffer.search(/\r?\n\r?\n/)
    }
  }

  if (shouldStop) return

  buffer += decoder.decode()
  if (buffer.trim()) await processBlock(buffer)
}

function createResponsesImageTool(
  params: TaskParams,
  isEdit: boolean,
  profile: ApiProfile,
  maskDataUrl?: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (profile.streamImages) {
    tool.partial_images = getStreamPartialImages(profile)
  }

  if (!profile.codexCli) {
    tool.quality = params.quality
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]): unknown {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

type ParsedImageResult = {
  image?: string
  url?: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}

function collectAssistantOutputText(output: ResponsesApiResponse['output']): string {
  if (!Array.isArray(output)) return ''
  return output
    .flatMap((item) => item?.type === 'message' && Array.isArray(item.content) ? item.content : [])
    .filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === 'object')
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text!.trim())
    .filter(Boolean)
    .join('\n\n')
}

function extractSvgMarkupFromText(text: string): string | undefined {
  const fencedMatch = text.match(/```svg\s*([\s\S]*?)```/i)
  const fencedSvg = fencedMatch?.[1]?.trim()
  if (fencedSvg?.startsWith('<svg') && fencedSvg.includes('</svg>')) return fencedSvg

  const rawMatch = text.match(/<svg\b[\s\S]*?<\/svg>/i)
  const rawSvg = rawMatch?.[0]?.trim()
  if (rawSvg) return rawSvg

  return undefined
}

function svgMarkupToDataUrl(svgMarkup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`
}

function getTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function getResponsesImageResultCandidate(result: ResponsesOutputItem['result'], depth = 0): { image?: string; url?: string } | undefined {
  if (depth > 6 || result == null) return undefined

  if (typeof result === 'string') {
    const value = result.trim()
    if (!value) return undefined
    return isHttpUrl(value) || isDataUrl(value) ? { url: value } : { image: value }
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      const candidate = getResponsesImageResultCandidate(item, depth + 1)
      if (candidate) return candidate
    }
    return undefined
  }

  if (!isRecordValue(result)) return undefined

  const base64Keys = ['b64_json', 'base64'] as const
  for (const key of base64Keys) {
    const value = getTrimmedString(result[key])
    if (value) return { image: value }
  }

  const directKeys = ['image', 'data', 'result', 'url', 'image_url', 'imageUrl', 'href', 'download_url', 'downloadUrl'] as const
  for (const key of directKeys) {
    const value = getTrimmedString(result[key])
    if (!value) continue
    return isHttpUrl(value) || isDataUrl(value) ? { url: value } : { image: value }
  }

  const nestedKeys = ['image', 'data', 'images', 'result', 'results', 'output', 'outputs', 'items', 'file', 'files', 'content'] as const
  for (const key of nestedKeys) {
    if (!(key in result)) continue
    const candidate = getResponsesImageResultCandidate(result[key], depth + 1)
    if (candidate) return candidate
  }

  for (const value of Object.values(result)) {
    if (typeof value === 'object' && value != null) {
      const candidate = getResponsesImageResultCandidate(value, depth + 1)
      if (candidate) return candidate
    }
  }

  return undefined
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string): ParsedImageResult[] {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    const err = new Error('接口未返回图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const results: ParsedImageResult[] = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const candidate = getResponsesImageResultCandidate(item.result)
    if (candidate?.image || candidate?.url) {
      results.push({
        image: candidate.image ? normalizeBase64Image(candidate.image, fallbackMime) : undefined,
        url: candidate.url,
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }

  if (!results.length) {
    const assistantText = collectAssistantOutputText(output)
    const svgMarkup = assistantText ? extractSvgMarkupFromText(assistantText) : undefined
    if (svgMarkup) {
      return [{
        image: svgMarkupToDataUrl(svgMarkup),
      }]
    }

    const message = assistantText
      ? `接口没有返回 image_generation_call，服务商实际返回了纯文本助手消息而非图片结果：${assistantText}`
      : '接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。'
    const err = new Error(message)
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return results
}

function createImageUrlProxyResolver(profile: ApiProfile, proxyConfig: ReturnType<typeof readClientDevProxyConfig>, useApiProxy: boolean): ((url: string) => string) | undefined {
  if (!useApiProxy) return undefined

  let upstreamOrigin = ''
  try {
    upstreamOrigin = new URL(normalizeBaseUrl(profile.baseUrl)).origin
  } catch {
    return undefined
  }
  if (!upstreamOrigin) return undefined

  if (typeof window !== 'undefined' && window.location.origin === upstreamOrigin) {
    return undefined
  }

  const proxyPrefix = proxyConfig?.prefix ?? '/api-proxy'
  return (url: string) => {
    if (!isHttpUrl(url)) return url
    try {
      const parsed = new URL(url)
      if (parsed.origin !== upstreamOrigin) return url
      return `${proxyPrefix}${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      return url
    }
  }
}

async function resolveParsedImageResults(
  results: ParsedImageResult[],
  mime: string,
  signal?: AbortSignal,
  resolveImageUrl?: (url: string) => string,
  rawPayload?: unknown,
): Promise<CallApiResult> {
  const images: string[] = []
  const actualParamsList: Array<Partial<TaskParams> | undefined> = []
  const revisedPrompts: Array<string | undefined> = []
  const rawImageUrls: string[] = []

  try {
    for (const item of results) {
      if (item.url) {
        rawImageUrls.push(item.url)
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal, resolveImageUrl?.(item.url)))
      } else if (item.image) {
        images.push(item.image)
      } else {
        continue
      }

      actualParamsList.push(mergeActualParams(item.actualParams ?? {}))
      revisedPrompts.push(item.revisedPrompt)
    }
  } catch (err) {
    if (err instanceof Error) {
      if (rawImageUrls.length > 0) (err as any).rawImageUrls = rawImageUrls
      if (rawPayload != null && !(typeof (err as any).rawResponsePayload === 'string')) {
        ;(err as any).rawResponsePayload = JSON.stringify(rawPayload, null, 2)
      }
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(rawPayload ?? results, null, 2)
    throw err
  }

  return {
    images,
    actualParams: mergeActualParams(actualParamsList[0] ?? {}),
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

async function parseImagesApiResponse(
  payload: ImageApiResponse,
  mime: string,
  signal?: AbortSignal,
  resolveImageUrl?: (url: string) => string,
): Promise<CallApiResult> {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error('接口没有返回图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  try {
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }

      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal, isHttpUrl(item.url) ? resolveImageUrl?.(item.url) : undefined))
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }
  } catch (err) {
    if (err instanceof Error) {
      if (rawImageUrls.length > 0) (err as any).rawImageUrls = rawImageUrls
      ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const actualParams = mergeActualParams(
    pickActualParams(payload),
  )
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function eventToImageResponseItem(event: Record<string, unknown>): ImageResponseItem {
  return {
    b64_json: getStringValue(event, 'b64_json'),
    revised_prompt: getStringValue(event, 'revised_prompt'),
    size: getStringValue(event, 'size'),
    quality: getStringValue(event, 'quality'),
    output_format: getStringValue(event, 'output_format'),
    output_compression: getNumberValue(event, 'output_compression'),
    moderation: getStringValue(event, 'moderation'),
  }
}

async function parseImagesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  const completedItems: ImageResponseItem[] = []
  let resultPayload: ImageApiResponse | null = null

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    const object = getStringValue(event, 'object')
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      const b64 = getStringValue(event, 'b64_json')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    if (object === 'image.generation.result' || object === 'image.edit.result') {
      resultPayload = normalizeImageApiPayload(event)
      return
    }

    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      completedItems.push(eventToImageResponseItem(event))
    }
  })

  if (resultPayload) {
    return parseImagesApiResponse(resultPayload, mime)
  }

  if (!completedItems.length) {
    throw new Error('流式接口未返回最终图片数据')
  }

  const images = completedItems
    .map((item) => item.b64_json)
    .filter((b64): b64 is string => Boolean(b64))
    .map((b64) => normalizeBase64Image(b64, mime))
  if (!images.length) throw new Error('流式接口未返回可用图片数据')

  const actualParamsList = completedItems.map((item) => mergeActualParams(pickActualParams(item)))
  const actualParams = mergeActualParams(
    actualParamsList[0],
    images.length > 1 ? { n: images.length } : undefined,
  )
  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts: completedItems.map((item) => item.revised_prompt),
  }
}

function getResponsesStreamPayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  if (isRecordValue(response)) return response as ResponsesApiResponse

  const item = event.item
  if (isRecordValue(item) && item.type === 'image_generation_call') {
    return { output: [item as ResponsesOutputItem] }
  }

  return null
}

async function parseResponsesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
  resolveImageUrl?: (url: string) => string,
): Promise<CallApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    if (type === 'response.image_generation_call.partial_image') {
      const b64 = getStringValue(event, 'partial_image_b64')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    const payload = getResponsesStreamPayload(event)
    if (!payload) return

    if (type === 'response.output_item.done' && Array.isArray(payload.output)) {
      outputItems.push(...payload.output)
      return
    }

    completedPayload = payload
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
      return STOP_READING_SSE
    }
  })

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error('流式接口未返回最终图片数据')

  let imageResults: ReturnType<typeof parseResponsesImageResults>
  try {
    imageResults = parseResponsesImageResults(payload, mime)
  } catch (err) {
    const collectedImageItems = outputItems.filter((item) => getResponsesImageResultCandidate(item.result))
    if (collectedImageItems.length === 0) throw err
    imageResults = parseResponsesImageResults({ output: collectedImageItems }, mime)
  }
  return resolveParsedImageResults(imageResults, mime, undefined, resolveImageUrl, payload)
}

export async function callOpenAICompatibleImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  if (customProvider) {
    return callCustomHttpImageApi(opts, profile, customProvider)
  }

  return callImagesApi(opts, { ...profile, apiMode: 'images', responseFormatB64Json: false })
}

async function callImagesApi(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if ((profile.codexCli || (profile.streamImages && n > 1)) && n > 1) {
    return callImagesApiConcurrent(opts, profile, n, customProvider)
  }

  return callImagesApiSingle(opts, profile, customProvider)
}

async function callImagesApiConcurrent(opts: CallApiOptions, profile: ApiProfile, n: number, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const singleOpts = {
    ...opts,
    params: {
      ...opts.params,
      n: 1,
      ...(profile.codexCli ? { quality: 'auto' as const } : {}),
    },
  }
  const results = await Promise.allSettled(
    Array.from({ length: n }).map((_, requestIndex) => callImagesApiSingle({
      ...singleOpts,
      onPartialImage: opts.onPartialImage
        ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
        : undefined,
    }, profile, customProvider)),
  )

  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function callImagesApiSingle(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  const { prompt: originalPrompt, params, inputImageDataUrls } = opts
  const prompt = profile.codexCli
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${originalPrompt}`
    : originalPrompt
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = isLimitedFreeApiKey(profile.apiKey) || shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const resolveImageUrl = createImageUrlProxyResolver(profile, proxyConfig, useApiProxy)
  const requestHeaders = createRequestHeaders(profile, useApiProxy)
  const paths = createOpenAICompatiblePaths(customProvider)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      formData.append('model', profile.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (!profile.codexCli) {
        formData.append('quality', params.quality)
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }
      if (params.n > 1) {
        formData.append('n', String(params.n))
      }
      if (profile.streamImages) {
        formData.append('stream', 'true')
        formData.append('partial_images', String(getStreamPartialImages(profile)))
      }

      const imageBlobs: Blob[] = []
      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const blob = opts.maskDataUrl && i === 0
          ? await imageDataUrlToPngBlob(dataUrl)
          : await dataUrlToBlob(dataUrl)
        imageBlobs.push(blob)
      }

      const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
      if (opts.maskDataUrl) {
        assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
        assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
      }
      assertImageInputPayloadSize(
        imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0),
      )

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      if (maskBlob) {
        formData.append('mask', maskBlob, 'mask.png')
      }

      response = await tracedFetch(buildApiUrl(profile.baseUrl, paths.editPath, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      }, traceMeta(profile, useApiProxy, 'images-edits'))
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt,
        size: params.size,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (!profile.codexCli) {
        body.quality = params.quality
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }
      if (profile.streamImages) {
        body.stream = true
        body.partial_images = getStreamPartialImages(profile)
      }

      response = await tracedFetch(buildApiUrl(profile.baseUrl, paths.generationPath, proxyConfig, useApiProxy), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      }, traceMeta(profile, useApiProxy, 'images-generations'))
    }

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseImagesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    return parseImagesApiResponse(await readJsonResponse<ImageApiResponse>(response), mime, controller.signal, resolveImageUrl)
  } finally {
    clearTimeout(timeoutId)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function getTaskState(payload: unknown, poll: CustomProviderPollMapping): 'success' | 'failure' | 'pending' {
  const status = getByPath(payload, poll.statusPath)
  const statusText = typeof status === 'string' ? status : String(status ?? '')
  if (poll.successValues.includes(statusText)) return 'success'
  if (poll.failureValues.includes(statusText)) return 'failure'
  return 'pending'
}

function isRecoverablePollingError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isRetryablePollingStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function buildTaskPath(path: string, taskId: string): string {
  return path
    .replace(/\{task_id\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
}

function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return getByPath(context, value.slice(1))
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}

function createCustomProviderContext(opts: CallApiOptions, profile: ApiProfile) {
  return {
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImages: {
      dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined,
      count: opts.inputImageDataUrls.length,
    },
    mask: {
      dataUrl: opts.maskDataUrl,
    },
  }
}

function renderQuery(query: Record<string, string> | undefined, context: Record<string, unknown>): Record<string, string> | undefined {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

async function createCustomMultipartBody(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, context: Record<string, unknown>): Promise<FormData> {
  const formData = new FormData()
  const body = resolveTemplateValue(mapping.body ?? {}, context)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) formData.append(key, String(item))
      } else {
        formData.append(key, String(value))
      }
    }
  }

  const needsInputImages = mapping.files?.some((file) => file.source === 'inputImages')
  const needsMask = mapping.files?.some((file) => file.source === 'mask')
  const imageBlobs: Blob[] = []
  if (needsInputImages) {
    for (let i = 0; i < opts.inputImageDataUrls.length; i++) {
      const dataUrl = opts.inputImageDataUrls[i]
      const blob = opts.maskDataUrl && i === 0 ? await imageDataUrlToPngBlob(dataUrl) : await dataUrlToBlob(dataUrl)
      imageBlobs.push(blob)
    }
  }
  const maskBlob = needsMask && opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
  if (opts.maskDataUrl && (needsInputImages || needsMask)) {
    assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
    assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
  }
  assertImageInputPayloadSize(imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0))

  for (const file of mapping.files ?? []) {
    if (file.source === 'inputImages') {
      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append(file.field, blob, `input-${i + 1}.${ext}`)
      }
    } else if (file.source === 'mask' && maskBlob) {
      formData.append(file.field, maskBlob, 'mask.png')
    }
  }

  return formData
}

async function extractCustomImages(
  payload: unknown,
  result: CustomProviderResultMapping,
  mime: string,
  signal?: AbortSignal,
  resolveImageUrl?: (url: string) => string,
): Promise<CallApiResult> {
  const images: string[] = []
  const imageUrls = (result.imageUrlPaths ?? []).flatMap((path) =>
    getAllByPath(payload, path).filter((value): value is string => isHttpUrl(value) || isDataUrl(value)),
  )
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  try {
    for (const path of result.b64JsonPaths ?? []) {
      for (const value of getAllByPath(payload, path)) {
        if (typeof value === 'string' && value.trim()) images.push(normalizeBase64Image(value, mime))
      }
    }
    for (const url of imageUrls) {
      images.push(await fetchImageUrlAsDataUrl(url, mime, signal, isHttpUrl(url) ? resolveImageUrl?.(url) : undefined))
    }
  } catch (err) {
    if (err instanceof Error) {
      if (rawImageUrls.length > 0) (err as any).rawImageUrls = rawImageUrls
      ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认接口实际返回的数据结构，并根据 API 文档调整「自定义服务商」配置中的结果提取路径。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function submitCustomRequest(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, profile: ApiProfile, controller: AbortController, proxyConfig: ReturnType<typeof readClientDevProxyConfig>, useApiProxy: boolean): Promise<unknown> {
  const requestHeaders = createRequestHeaders(profile, useApiProxy)
  const context = createCustomProviderContext(opts, profile)
  const method = mapping.method ?? 'POST'
  const contentType = mapping.contentType ?? 'json'
  const path = appendQuery(mapping.path, renderQuery(mapping.query, context))
  const headers: Record<string, string> = { ...requestHeaders }
  let body: BodyInit | undefined

  if (method !== 'GET') {
    if (contentType === 'multipart') {
      const formData = await createCustomMultipartBody(mapping, opts, context)
      body = formData
    } else {
      assertImageInputPayloadSize(
        opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
          (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
      )
      headers['Content-Type'] = 'application/json'
      const resolved = resolveTemplateValue(mapping.body ?? {}, context)
      body = JSON.stringify(resolved)
    }
  }

  const response = await tracedFetch(buildApiUrl(profile.baseUrl, path, proxyConfig, useApiProxy), {
    method,
    headers,
    cache: 'no-store',
    body,
    signal: controller.signal,
  }, traceMeta(profile, useApiProxy, 'custom-submit'))

  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  return readJsonResponse(response)
}

async function pollCustomTaskResult(
  profile: ApiProfile,
  poll: CustomProviderPollMapping,
  taskId: string,
  mime: string,
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = createRequestHeaders(profile, false)
  const resolveImageUrl = createImageUrlProxyResolver(profile, proxyConfig, false)
  let isFirstPoll = true

  while (true) {
    if (isFirstPoll) {
      isFirstPoll = false
    } else if (signal) {
      await sleep((poll.intervalSeconds ?? 5) * 1000, signal)
    } else {
      await new Promise((resolve) => setTimeout(resolve, (poll.intervalSeconds ?? 5) * 1000))
    }

    const taskPath = appendQuery(buildTaskPath(poll.path, taskId), poll.query)
    let taskPayload: unknown
    try {
      const taskResponse = await tracedFetch(buildApiUrl(profile.baseUrl, taskPath, proxyConfig, false), {
        method: poll.method ?? 'GET',
        headers: requestHeaders,
        cache: 'no-store',
        signal,
      }, traceMeta(profile, false, 'custom-poll'))

      if (!taskResponse.ok) {
        if (isRetryablePollingStatus(taskResponse.status)) continue
        throw new Error(await getApiErrorMessage(taskResponse))
      }

      taskPayload = await readJsonResponse(taskResponse, '异步任务查询返回空响应，请稍后重试')
    } catch (err) {
      if (!signal?.aborted && isRecoverablePollingError(err)) continue
      throw err
    }

    const state = getTaskState(taskPayload, poll)
    if (state === 'failure') {
      const message = getByPath(taskPayload, poll.errorPath) || getByPath(taskPayload, 'message') || getByPath(taskPayload, 'data.fail_reason') || getByPath(taskPayload, 'error.message')
      throw new Error(typeof message === 'string' && message.trim() ? message : '异步任务失败')
    }
    if (state === 'success') {
      try {
        return await extractCustomImages(taskPayload, poll.result, mime, signal, resolveImageUrl)
      } catch (err) {
        if (!signal?.aborted && isRecoverablePollingError(err)) continue
        throw err
      }
    }
  }
}

export async function getCustomQueuedImageResult(
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  taskId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  if (!customProvider.poll) throw new Error('自定义异步任务缺少 poll 配置')
  const mime = MIME_MAP[params.output_format] || 'image/png'
  return pollCustomTaskResult(profile, customProvider.poll, taskId, mime)
}

async function callCustomHttpImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider: CustomProviderDefinition): Promise<CallApiResult> {
  const { params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    const proxyConfig = readClientDevProxyConfig()
    const useApiProxy = isLimitedFreeApiKey(profile.apiKey) || shouldUseApiProxy(profile.apiProxy, proxyConfig)
    const submitMapping = isEdit && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
    if (useApiProxy && (submitMapping.method ?? 'POST') !== 'POST') {
      throw new Error('API 代理暂不支持使用 GET 提交的自定义服务商。请关闭 API 代理，或改用 POST 提交的自定义服务商配置。')
    }
    if (useApiProxy && (submitMapping.taskIdPath || customProvider.poll)) {
      throw new Error('API 代理暂不支持使用异步任务的自定义服务商。请关闭 API 代理，或改用同步返回图片的自定义服务商配置。')
    }
    const submitPayload = await submitCustomRequest(submitMapping, opts, profile, controller, proxyConfig, useApiProxy)
    const taskIdValue = submitMapping.taskIdPath ? getByPath(submitPayload, submitMapping.taskIdPath) : undefined
    const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
    if (submitMapping.taskIdPath && !taskId) {
      const err = new Error('无法从响应中提取异步任务 ID，请查看原始响应内容确认接口实际返回的数据结构，并根据 API 文档调整「自定义服务商」配置中的 taskIdPath。')
      ;(err as any).rawResponsePayload = JSON.stringify(submitPayload, null, 2)
      throw err
    }
    if (!taskId) return extractCustomImages(submitPayload, submitMapping.result ?? {}, mime, controller.signal)
    if (!customProvider.poll) throw new Error('异步接口返回了 task_id，但服务商配置缺少 poll')
    opts.onCustomTaskEnqueued?.({ taskId })
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    return pollCustomTaskResult(profile, customProvider.poll, taskId, mime, controller.signal)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) {
    return callResponsesImageApiSingle(opts, profile)
  }

  const promises = Array.from({ length: n }).map((_, requestIndex) => callResponsesImageApiSingle({
    ...opts,
    onPartialImage: opts.onPartialImage
      ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
      : undefined,
  }, profile))
  const results = await Promise.allSettled(promises)
  
  const successfulResults = results
    .filter((r): r is PromiseFulfilledResult<CallApiResult> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (successfulResults.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有并发请求均失败')
  }

  const images = successfulResults.flatMap((r) => r.images)
  const actualParamsList = successfulResults.flatMap((r) =>
    r.actualParamsList?.length ? r.actualParamsList : r.images.map(() => r.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((r) =>
    r.revisedPrompts?.length ? r.revisedPrompts : r.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((r) => r.rawImageUrls ?? [])
  const actualParams = mergeActualParams(
    successfulResults[0]?.actualParams ?? {},
    images.length === opts.params.n ? { n: opts.params.n } : { n: images.length },
  )

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function callResponsesImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt, params, inputImageDataUrls } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = isLimitedFreeApiKey(profile.apiKey) || shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const resolveImageUrl = createImageUrlProxyResolver(profile, proxyConfig, useApiProxy)
  const requestHeaders = createRequestHeaders(profile, useApiProxy)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const body: Record<string, unknown> = {
      model: profile.model,
      input: createResponsesInput(prompt, inputImageDataUrls),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl)],
      tool_choice: 'required',
    }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await tracedFetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    }, traceMeta(profile, useApiProxy, 'responses-image'))

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseResponsesApiStreamResponse(response, mime, opts.onPartialImage, resolveImageUrl)
    }

    const payload = await readJsonResponse<ResponsesApiResponse>(response)
    const imageResults = parseResponsesImageResults(payload, mime)
    return resolveParsedImageResults(imageResults, mime, controller.signal, resolveImageUrl, payload)
  } finally {
    clearTimeout(timeoutId)
  }
}
