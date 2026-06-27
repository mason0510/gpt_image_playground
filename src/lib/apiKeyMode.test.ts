import { describe, expect, it } from 'vitest'
import {
  createApiAuthorizationHeaders,
  applySizeSelectionByApiKey,
  getApiKeySourceLabel,
  getApiKeySource,
  getApiKeyUsagePolicy,
  isSizeTierAllowedByApiKey,
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

  it('returns source labels', () => {
    expect(getApiKeySourceLabel(LIMITED_FREE_API_KEY_SENTINEL)).toBe('限时免费 key')
    expect(getApiKeySourceLabel('sk-custom')).toBe('自定义 API Key')
  })

  it('returns usage policy for free and custom keys', () => {
    expect(getApiKeyUsagePolicy(LIMITED_FREE_API_KEY_SENTINEL)).toMatchObject({
      source: 'limited-free',
      maxImagesPerRequest: 2,
      allowedSizeTiers: ['1K', '2K'],
      allowCustomResolution: false,
    })
    expect(getApiKeyUsagePolicy('sk-custom')).toMatchObject({
      source: 'custom',
      allowCustomResolution: true,
    })
    expect(getApiKeyUsagePolicy('sk-custom').maxImagesPerRequest).toBeUndefined()
    expect(isSizeTierAllowedByApiKey(LIMITED_FREE_API_KEY_SENTINEL, '4K')).toBe(false)
    expect(isSizeTierAllowedByApiKey('sk-custom', '4K')).toBe(true)
  })

  it('applies size selection by api key mode', () => {
    expect(applySizeSelectionByApiKey('3840x2160', LIMITED_FREE_API_KEY_SENTINEL)).toBe('2560x1440')
    expect(applySizeSelectionByApiKey('3840x2160', 'sk-custom')).toBe('3840x2160')
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
