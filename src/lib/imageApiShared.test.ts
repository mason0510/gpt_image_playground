import { describe, expect, it } from 'vitest'
import { readJsonResponse } from './imageApiShared'

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
