import { describe, expect, it } from 'vitest'
import {
  createApiAuthorizationHeaders,
  getApiKeySource,
  isLimitedFreeApiKey,
  LIMITED_FREE_API_KEY_HEADER,
  LIMITED_FREE_API_KEY_HEADER_VALUE,
  LIMITED_FREE_API_KEY_SENTINEL,
  LIMITED_FREE_DEVICE_FINGERPRINT_HEADER,
} from './apiKeyMode'

describe('apiKeyMode', () => {
  it('detects limited-free sentinel only', () => {
    expect(isLimitedFreeApiKey(LIMITED_FREE_API_KEY_SENTINEL)).toBe(true)
    expect(isLimitedFreeApiKey(`  ${LIMITED_FREE_API_KEY_SENTINEL}  `)).toBe(true)
    expect(isLimitedFreeApiKey('sk-custom')).toBe(false)
    expect(isLimitedFreeApiKey('')).toBe(false)
    expect(isLimitedFreeApiKey(null)).toBe(false)
  })

  it('returns custom or limited-free source', () => {
    expect(getApiKeySource(LIMITED_FREE_API_KEY_SENTINEL)).toBe('limited-free')
    expect(getApiKeySource('sk-custom')).toBe('custom')
  })

  it('uses bearer header for custom keys', () => {
    expect(createApiAuthorizationHeaders('sk-custom', false)).toEqual({
      Authorization: 'Bearer sk-custom',
    })
  })

  it('uses sentinel and mode header for limited-free through same-origin proxy', () => {
    expect(createApiAuthorizationHeaders(LIMITED_FREE_API_KEY_SENTINEL, true)).toMatchObject({
      Authorization: `Bearer ${LIMITED_FREE_API_KEY_SENTINEL}`,
      [LIMITED_FREE_API_KEY_HEADER]: LIMITED_FREE_API_KEY_HEADER_VALUE,
    })
    expect(createApiAuthorizationHeaders(LIMITED_FREE_API_KEY_SENTINEL, true)[LIMITED_FREE_DEVICE_FINGERPRINT_HEADER]).toBeTruthy()
  })

  it('rejects limited-free without same-origin proxy', () => {
    expect(() => createApiAuthorizationHeaders(LIMITED_FREE_API_KEY_SENTINEL, false))
      .toThrow('限时免费 key 只能通过站内同源代理使用')
  })
})
