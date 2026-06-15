import type { AppSettings, TaskParams } from '../types'
import { formatHttpApiErrorMessage, getApiTraceIdFromResponse } from './apiDebugTrace'

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => void
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

export const IMAGE_FETCH_CORS_HINT = ' 可点链接按钮复制结果链接，或尝试开启「返回 Base64 图片数据」避免此问题。'

async function probeNoCorsReachability(url: string, timeoutMs = 8000): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal, fetchUrlOverride?: string): Promise<string> {
  if (isDataUrl(url)) return url
  const requestUrl = fetchUrlOverride ?? url

  let response: Response
  try {
    response = await fetch(requestUrl, {
      cache: 'no-store',
      signal,
    })
  } catch (err) {
    if (err instanceof TypeError) {
      const probe = await probeNoCorsReachability(requestUrl)
      if (probe === 'opaque') {
        throw new Error(`图片已生成，但因服务商未允许跨域，图片链接下载失败。${IMAGE_FETCH_CORS_HINT}`)
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(`图片链接下载失败（网络不可用）。${IMAGE_FETCH_CORS_HINT}`)
      }
      throw new Error(`图片链接下载失败（可能因跨域限制、链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

function pickJsonErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message
  }
  if (typeof record.detail === 'string' && record.detail.trim()) return record.detail
  if (Array.isArray(record.detail)) {
    const detail = record.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n').trim()
    if (detail) return detail
  }
  if (typeof error === 'string' && error.trim()) return error
  if (typeof record.message === 'string' && record.message.trim()) return record.message
  return undefined
}

function pickJsonErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  if (typeof record.code === 'string' && record.code.trim()) return record.code.trim()
  return undefined
}

export function normalizeApiErrorMessage(message: string): string {
  const text = message.trim()
  if (!text) return '服务返回了空响应体，请稍后重试'
  if (/Unexpected end of JSON input|Failed to execute 'json' on 'Response'/i.test(text)) {
    return '服务返回了空响应体，请稍后重试'
  }
  return text
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()

  if (!trimmed) {
    errorMsg = `服务返回了空错误响应（HTTP ${response.status}）`
  } else {
    try {
      const errJson = JSON.parse(trimmed)
      const message = pickJsonErrorMessage(errJson) ?? trimmed
      const code = pickJsonErrorCode(errJson)
      errorMsg = code ? `${message}\n错误代码：${code}` : message
    } catch {
      errorMsg = trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed
    }
  }

  return formatHttpApiErrorMessage(normalizeApiErrorMessage(errorMsg), getApiTraceIdFromResponse(response))
}

export async function readJsonResponse<T = unknown>(response: Response, fallbackMessage = '服务返回了空响应体，请稍后重试'): Promise<T> {
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error(formatHttpApiErrorMessage(fallbackMessage, getApiTraceIdFromResponse(response)))
  }
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const preview = trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed
    throw new Error(formatHttpApiErrorMessage(`服务返回内容不是有效 JSON：${preview}`, getApiTraceIdFromResponse(response)))
  }
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high') {
    actualParams.quality = record.quality
  }
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}
