import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../types'
import { getActiveApiProfile, isBuiltInOpenAICompatibleProvider } from './apiProfiles'
import { getApiKeyUsagePolicy, resolveSizeSelectionByApiKey } from './apiKeyMode'
import { calculateImageSize, normalizeImageSize } from './size'

export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const LIMITED_FREE_MAX_OUTPUT_IMAGES_PER_REQUEST = 2
export const LEGACY_MAX_OUTPUT_IMAGES_PER_REQUEST = 4
export const FRONTEND_MAX_IMAGE_SIZE_TIER = '2K'

const FRONTEND_MAX_IMAGE_PIXELS = 2048 * 2048

export function getOutputImageLimitForSettings(settings: AppSettings): number | undefined {
  const activeProfile = getActiveApiProfile(settings)
  return getApiKeyUsagePolicy(activeProfile.apiKey).maxImagesPerRequest
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const normalizedSize = normalizeImageSize(params.size) || DEFAULT_PARAMS.size
  const nextParams: TaskParams = {
    ...params,
    size: normalizeSizeForSettings(normalizedSize, settings),
    quality: normalizeQuality(params.quality),
    output_format: normalizeOutputFormat(params.output_format),
    moderation: normalizeModeration(params.moderation),
    n: outputImageLimit == null ? Math.max(1, params.n || DEFAULT_PARAMS.n) : Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (isBuiltInOpenAICompatibleProvider(activeProfile.provider) && activeProfile.codexCli) {
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (activeProfile.provider === 'fal') {
    if (!options.hasInputImages && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
    if (nextParams.quality === 'auto') nextParams.quality = 'high'
    nextParams.moderation = DEFAULT_PARAMS.moderation
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

export function normalizeSizeForSettings(size: string, settings: AppSettings): string {
  const activeProfile = getActiveApiProfile(settings)
  return resolveSizeSelectionByApiKey(size, activeProfile.apiKey).size
}

export function capImageSizeToFrontendLimit(size: string): string {
  if (size === 'auto') return size
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) return size

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return size
  if (width * height <= FRONTEND_MAX_IMAGE_PIXELS) return size

  return calculateImageSize(FRONTEND_MAX_IMAGE_SIZE_TIER, `${width}:${height}`) ?? '2048x2048'
}

export function normalizeOutputFormat(value: unknown): TaskParams['output_format'] {
  return value === 'png' || value === 'jpeg' || value === 'webp' ? value : DEFAULT_PARAMS.output_format
}

function normalizeQuality(value: unknown): TaskParams['quality'] {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' ? value : DEFAULT_PARAMS.quality
}

function normalizeModeration(value: unknown): TaskParams['moderation'] {
  return value === 'auto' || value === 'low' ? value : DEFAULT_PARAMS.moderation
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
