import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { getOutputImageLimitForSettings, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 4 per request', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(4)
  })

  it('migrates legacy fal.ai settings to OpenAI-compatible limits', () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [{
        id: 'legacy-fal',
        name: 'Legacy fal',
        provider: 'fal',
        baseUrl: 'https://proxy.example.com',
        apiKey: 'fal-key',
        model: 'openai/gpt-image-2',
        timeout: 600,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'legacy-fal',
    })

    expect(settings.profiles[0].provider).toBe('sublb')
    expect(getOutputImageLimitForSettings(settings)).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8 }, settings).n).toBe(4)
  })

  it('keeps OpenAI streaming output count so the request can disable streaming', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4 }, settings).n).toBe(4)
  })

  it('keeps auto size after migrating legacy fal.ai settings to SubLB', () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [{
        id: 'legacy-fal',
        name: 'Legacy fal',
        provider: 'fal',
        baseUrl: 'https://proxy.example.com',
        apiKey: 'fal-key',
        model: 'openai/gpt-image-2',
        timeout: 600,
        apiMode: 'images',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'legacy-fal',
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('auto')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings, { hasInputImages: true }).size).toBe('auto')
  })

  it('falls back invalid persisted output format before submit or edit request', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    const unsafeParams = {
      ...DEFAULT_PARAMS,
      output_format: 'pong',
    } as unknown as typeof DEFAULT_PARAMS

    expect(normalizeParamsForSettings(unsafeParams, settings).output_format).toBe('png')
  })
})
