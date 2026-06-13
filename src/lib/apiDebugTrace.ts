import type { ApiProfile } from '../types'

export interface ApiTraceContext {
  traceId: string
  startedAt: number
  method: string
  url: string
  provider?: string
  apiMode?: string
  model?: string
  useApiProxy?: boolean
  label?: string
}

export interface ApiTraceInput {
  url: string
  method?: string
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'model'>
  useApiProxy?: boolean
  label?: string
}

function createTraceId(): string {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8)
  return `img_${stamp}_${random}`
}

export function createApiTraceContext(input: ApiTraceInput): ApiTraceContext {
  return {
    traceId: createTraceId(),
    startedAt: Date.now(),
    method: input.method ?? 'GET',
    url: input.url,
    provider: input.profile?.provider,
    apiMode: input.profile?.apiMode,
    model: input.profile?.model,
    useApiProxy: input.useApiProxy,
    label: input.label,
  }
}

function getElapsedMs(ctx: ApiTraceContext): number {
  return Math.max(0, Date.now() - ctx.startedAt)
}

function toLogPayload(ctx: ApiTraceContext, phase: 'request' | 'response' | 'error', extra: Record<string, unknown> = {}) {
  return {
    traceId: ctx.traceId,
    phase,
    method: ctx.method,
    url: ctx.url,
    provider: ctx.provider,
    apiMode: ctx.apiMode,
    model: ctx.model,
    useApiProxy: ctx.useApiProxy,
    label: ctx.label,
    elapsedMs: getElapsedMs(ctx),
    ...extra,
  }
}

export function logApiRequestStart(ctx: ApiTraceContext) {
  console.debug('[api-trace]', toLogPayload(ctx, 'request'))
}

export function logApiResponse(ctx: ApiTraceContext, response: Response, bodyPreview?: string) {
  console.debug('[api-trace]', toLogPayload(ctx, 'response', {
    status: response.status,
    ok: response.ok,
    bodyPreview: bodyPreview ? bodyPreview.slice(0, 1000) : undefined,
  }))
}

export function logApiError(ctx: ApiTraceContext, error: unknown) {
  console.debug('[api-trace]', toLogPayload(ctx, 'error', {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
  }))
}

function withTraceHeader(headers: HeadersInit | undefined, traceId: string): Headers {
  const next = new Headers(headers)
  next.set('x-client-trace-id', traceId)
  return next
}

export function appendTraceIdToMessage(message: string, traceId?: string): string {
  if (!traceId || message.includes('调试编号：')) return message
  return `${message}\n调试编号：${traceId}`
}

export function formatHttpApiErrorMessage(message: string, traceId?: string): string {
  if (!traceId) return message
  if (message.includes('调试编号：')) return message
  return `请求失败，请检查接口配置或稍后重试。\n调试编号：${traceId}\n详细原因：${message}`
}

export function getApiTraceIdFromResponse(response: Response): string | undefined {
  const traceId = (response as Response & { __apiTraceId?: unknown }).__apiTraceId
  return typeof traceId === 'string' ? traceId : undefined
}

export function formatNetworkApiError(err: unknown, traceId: string): Error {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return err
  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(rawMessage)
    ? `请求未发出或被浏览器拦截。\n调试编号：${traceId}\n详细原因：${rawMessage}\n可能原因：网络中断、浏览器扩展拦截、旧缓存、CORS/代理不可达。`
    : `请求失败，请检查接口配置或稍后重试。\n调试编号：${traceId}\n详细原因：${rawMessage}`
  return new Error(message)
}

export async function tracedFetch(input: string, init: RequestInit = {}, traceInput: Omit<ApiTraceInput, 'url' | 'method'> = {}): Promise<Response> {
  const method = init.method ?? 'GET'
  const ctx = createApiTraceContext({ ...traceInput, url: input, method })
  logApiRequestStart(ctx)
  try {
    const response = await fetch(input, {
      ...init,
      headers: withTraceHeader(init.headers, ctx.traceId),
    })
    ;(response as Response & { __apiTraceId?: string }).__apiTraceId = ctx.traceId
    const bodyPreview = response.ok ? undefined : await response.clone().text().catch(() => undefined)
    logApiResponse(ctx, response, bodyPreview)
    return response
  } catch (err) {
    logApiError(ctx, err)
    throw formatNetworkApiError(err, ctx.traceId)
  }
}
