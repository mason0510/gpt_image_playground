import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../types'
import { getActiveApiProfile, isBuiltInOpenAICompatibleProvider } from './apiProfiles'
import { normalizeImageSize } from './size'

export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const MAX_OUTPUT_IMAGES_PER_REQUEST = 4

export function getOutputImageLimitForSettings(settings: AppSettings) {
  getActiveApiProfile(settings)
  return MAX_OUTPUT_IMAGES_PER_REQUEST
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    quality: normalizeQuality(params.quality),
    output_format: normalizeOutputFormat(params.output_format),
    moderation: normalizeModeration(params.moderation),
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
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
