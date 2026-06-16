import type { ComplianceGateStorage } from './types'

function getCookie(name: string) {
  if (typeof document === 'undefined') return null
  const encodedName = encodeURIComponent(name)
  const cookies = document.cookie ? document.cookie.split('; ') : []
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.split('=')
    if (rawKey === encodedName) return decodeURIComponent(rawValue.join('='))
  }
  return null
}

function setCookie(name: string, value: string) {
  if (typeof document === 'undefined') return
  const maxAge = 60 * 60 * 24 * 365
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`
}

export function createComplianceStorage(storageKey: string): ComplianceGateStorage {
  return {
    isConfirmed: () => {
      if (typeof window === 'undefined') return false
      try {
        if (window.localStorage.getItem(storageKey) === 'true') return true
      } catch {
        // localStorage 不可用时继续尝试 cookie fallback。
      }
      return getCookie(storageKey) === 'true'
    },
    confirm: () => {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, 'true')
        } catch {
          // localStorage 不可用时使用 cookie fallback。
        }
      }
      setCookie(storageKey, 'true')
    },
  }
}
