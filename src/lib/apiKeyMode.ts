export const LIMITED_FREE_API_KEY_SENTINEL = '__IMAGINATION_SPACE_LIMITED_FREE_KEY__'
export const LIMITED_FREE_API_KEY_HEADER = 'X-Imagination-Space-Key-Mode'
export const LIMITED_FREE_API_KEY_HEADER_VALUE = 'limited-free'
export const LIMITED_FREE_DEVICE_FINGERPRINT_HEADER = 'X-Imagination-Space-Device-Fingerprint'

const LIMITED_FREE_DEVICE_ID_KEY = 'imagination-space-limited-free-device-id'

export function isLimitedFreeApiKey(apiKey: string | undefined | null): boolean {
  return String(apiKey ?? '').trim() === LIMITED_FREE_API_KEY_SENTINEL
}

export function getApiKeySource(apiKey: string | undefined | null): 'limited-free' | 'custom' {
  return isLimitedFreeApiKey(apiKey) ? 'limited-free' : 'custom'
}

export function createApiAuthorizationHeaders(apiKey: string, useApiProxy: boolean): Record<string, string> {
  if (!isLimitedFreeApiKey(apiKey)) {
    return { Authorization: `Bearer ${apiKey}` }
  }

  if (!useApiProxy) {
    throw new Error('限时免费 key 只能通过站内同源代理使用，请开启 API 代理或填写自己的 API Key。')
  }

  return {
    Authorization: `Bearer ${LIMITED_FREE_API_KEY_SENTINEL}`,
    [LIMITED_FREE_API_KEY_HEADER]: LIMITED_FREE_API_KEY_HEADER_VALUE,
    [LIMITED_FREE_DEVICE_FINGERPRINT_HEADER]: getOrCreateLimitedFreeDeviceFingerprint(),
  }
}

function getOrCreateLimitedFreeDeviceFingerprint(): string {
  if (typeof window === 'undefined') return 'server'

  let deviceId = ''
  try {
    deviceId = window.localStorage.getItem(LIMITED_FREE_DEVICE_ID_KEY) || ''
    if (!deviceId) {
      deviceId = createRandomId()
      window.localStorage.setItem(LIMITED_FREE_DEVICE_ID_KEY, deviceId)
    }
  } catch {
    deviceId = createRandomId()
  }

  const nav = window.navigator
  const traits = [
    deviceId,
    nav.platform || '',
    nav.language || '',
    String(nav.hardwareConcurrency || ''),
    String(nav.maxTouchPoints || ''),
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    `${window.screen?.width || 0}x${window.screen?.height || 0}x${window.screen?.colorDepth || 0}`,
  ].join('|')

  return encodeHeaderValue(traits).slice(0, 512)
}

function createRandomId(): string {
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  const bytes = new Uint8Array(16)
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function encodeHeaderValue(value: string): string {
  try {
    return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  } catch {
    return value.replace(/[^\w.-]/g, '_')
  }
}
