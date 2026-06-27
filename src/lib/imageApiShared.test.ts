import { describe, expect, it } from 'vitest'
import { getApiErrorMessage, normalizeApiErrorMessage, readJsonResponse } from './imageApiShared'
import type { ApiTraceContext } from './apiDebugTrace'

function withTrace(response: Response, traceId: string, traceContext?: Partial<ApiTraceContext>): Response {
  ;(response as Response & { __apiTraceId?: string }).__apiTraceId = traceId
  if (traceContext) {
    ;(response as Response & { __apiTraceContext?: ApiTraceContext }).__apiTraceContext = {
      traceId,
      startedAt: 0,
      method: 'POST',
      url: '/api-proxy/v1/images/generations',
      useApiProxy: true,
      ...traceContext,
    }
  }
  return response
}

describe('readJsonResponse', () => {
  it('returns parsed JSON payload', async () => {
    await expect(readJsonResponse(new Response('{"ok":true}'))).resolves.toEqual({ ok: true })
  })

  it('turns empty success body into a readable Chinese error', async () => {
    await expect(readJsonResponse(withTrace(new Response(''), 'req-empty-body'))).rejects.toThrow('详细原因：服务返回了空响应体，请稍后重试')
    await expect(readJsonResponse(withTrace(new Response(''), 'req-empty-body'))).rejects.toThrow('调试编号：req-empty-body')
  })

  it('turns invalid JSON body into a readable Chinese error', async () => {
    await expect(readJsonResponse(withTrace(new Response('<html>bad gateway</html>'), 'req-invalid-json'))).rejects.toThrow('详细原因：服务返回内容不是有效 JSON：<html>bad gateway</html>')
    await expect(readJsonResponse(withTrace(new Response('<html>bad gateway</html>'), 'req-invalid-json'))).rejects.toThrow('调试编号：req-invalid-json')
  })
})


describe('getApiErrorMessage', () => {
  it('turns empty error body into a readable Chinese error without leaking JSON parse internals', async () => {
    const message = await getApiErrorMessage(withTrace(new Response('', { status: 502 }), 'req-empty-error'))
    expect(message).toContain('服务返回了空错误响应（HTTP 502）')
    expect(message).toContain('调试编号：req-empty-error')
    expect(message).not.toContain('Unexpected end of JSON input')
  })

  it('returns non-JSON error body text instead of throwing', async () => {
    const message = await getApiErrorMessage(new Response('bad gateway', { status: 502 }))
    expect(message).toBe('bad gateway')
  })

  it('includes upstream error code when present in json error payload', async () => {
    const message = await getApiErrorMessage(withTrace(new Response(JSON.stringify({
      error: {
        message: 'Upstream rate limit exceeded, please retry later',
        code: 'upstream_rate_limit',
      },
    }), { status: 429 }), 'req-upstream-rate-limit'))
    expect(message).toContain('Upstream rate limit exceeded, please retry later')
    expect(message).toContain('错误代码：upstream_rate_limit')
    expect(message).toContain('调试编号：req-upstream-rate-limit')
  })

  it('passes raw errors through without friendly rewrite', () => {
    expect(normalizeApiErrorMessage('Unexpected end of JSON input')).toBe('Unexpected end of JSON input')
    expect(normalizeApiErrorMessage("Failed to execute 'json' on 'Response': Unexpected end of JSON input")).toBe("Failed to execute 'json' on 'Response': Unexpected end of JSON input")
    expect(normalizeApiErrorMessage('Service temporarily unavailable')).toBe('Service temporarily unavailable')
    expect(normalizeApiErrorMessage('上游返回空响应体（upstream_status=200, content_type=""）\n错误代码：empty_upstream')).toBe('上游返回空响应体（upstream_status=200, content_type=""）\n错误代码：empty_upstream')
  })

  it('passes empty upstream body error through with no-charge retry hint from backend', async () => {

    const message = await getApiErrorMessage(withTrace(new Response(JSON.stringify({
      error: {
        message: '上游这次返回了空结果，系统已自动间隔 10 秒重试但仍失败。本次不扣免费次数，请稍后直接重试。（upstream_status=200, content_type=""）',
        code: 'empty_upstream_body',
      },
    }), { status: 502 }), 'img_test_empty'))
    expect(message).toContain('本次不扣免费次数')
    expect(message).toContain('调试编号：img_test_empty')
  })

  it('passes upstream timeout through without rewrite', async () => {
    expect(normalizeApiErrorMessage('上游生图超过 240 秒仍未完成，请稍后重试或降低尺寸/质量。\n错误代码：upstream_timeout')).toBe('上游生图超过 240 秒仍未完成，请稍后重试或降低尺寸/质量。\n错误代码：upstream_timeout')

    const message = await getApiErrorMessage(new Response(JSON.stringify({
      error: {
        message: '上游生图超过 240 秒仍未完成，请稍后重试或降低尺寸/质量。',
        code: 'upstream_timeout',
      },
    }), { status: 504 }))
    expect(message).toBe('上游生图超过 240 秒仍未完成，请稍后重试或降低尺寸/质量。\n错误代码：upstream_timeout')
  })
})

describe('mergeActualParamsListWithMeasuredSize', () => {
  it('keeps api actual params but overrides size with measured image size', async () => {
    const mod = await import('./imageApiShared')
    expect(mod.mergeActualParamsListWithMeasuredSize(
      [{ size: '2304x3456', quality: 'high', output_format: 'png' }],
      [{ size: '1024x1536' }],
    )).toEqual([
      { size: '1024x1536', quality: 'high', output_format: 'png' },
    ])
  })

  it('falls back to measured size when the api omitted actual params', async () => {
    const mod = await import('./imageApiShared')
    expect(mod.mergeActualParamsListWithMeasuredSize(
      undefined,
      [{ size: '3840x2160' }],
    )).toEqual([
      { size: '3840x2160' },
    ])
  })
})
