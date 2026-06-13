import { describe, expect, it } from 'vitest'
import { getApiErrorMessage, normalizeApiErrorMessage, readJsonResponse } from './imageApiShared'

function withTrace(response: Response, traceId: string): Response {
  ;(response as Response & { __apiTraceId?: string }).__apiTraceId = traceId
  return response
}

describe('readJsonResponse', () => {
  it('returns parsed JSON payload', async () => {
    await expect(readJsonResponse(new Response('{"ok":true}'))).resolves.toEqual({ ok: true })
  })

  it('turns empty success body into a readable Chinese error', async () => {
    await expect(readJsonResponse(withTrace(new Response(''), 'req-empty-body'))).rejects.toThrow('详细原因：服务返回了空响应，请稍后重试')
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

  it('normalizes raw browser JSON parse errors', () => {
    expect(normalizeApiErrorMessage('Unexpected end of JSON input')).toBe('服务返回了空响应，请稍后重试')
    expect(normalizeApiErrorMessage("Failed to execute 'json' on 'Response': Unexpected end of JSON input")).toBe('服务返回了空响应，请稍后重试')
  })
})
