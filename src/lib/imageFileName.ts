import type { TaskRecord } from '../types'

const GENERIC_STOP_TOKENS = new Set([
  '生成',
  '一张',
  '一个',
  '请',
  '帮我',
  '做一张',
  '做个',
  '制作',
  '设计',
  '输出',
  '适合',
  '用于',
  '需要',
  '要求',
  '整体',
  '画面',
  '背景',
  '文字',
  '如下',
  '改成',
  '确认',
  '如果',
  '可以',
  '目前',
  '直接',
  '不要',
  '必须',
  '清晰',
  '可读',
  '现代',
  '专业',
  '醒目',
  '质感',
  '风格',
  '构图',
  '高端',
  '商业',
  '传播',
  '图片',
  '海报文字',
  '负面提示词',
  'prompt',
  'image',
])

const LEADING_PHRASES = [
  '生成一张',
  '生成一个',
  '生成',
  '请生成',
  '请做',
  '请帮我',
  '帮我',
  '做一张',
  '做个',
  '设计一张',
  '设计一个',
  '适合',
  '用于',
  '整体',
  '背景使用',
  '背景',
  '海报文字必须',
  '文字排版如下',
  '文字如下',
  '如果你确认',
  '可以把主标题改成',
  '主标题改成',
]

const LABEL_VALUE_PATTERN = /(?:主标题|副标题|标题为|标题|中间小标题|顶部大字|底部超大价格|底部价格|价格|主题|关键词|文案)\s*[：:]\s*([^\n，,。；;]{1,40})/g
const QUOTED_VALUE_PATTERN = /[「“"]([^」”"\n]{2,40})[」”"]/g
const PRICE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:刀|元|美元|张|个|月卡|年卡)\b/gi
const ASCII_PHRASE_PATTERN = /\b[A-Za-z][A-Za-z0-9.+#-]*(?:\s+[A-Za-z0-9.+#-]+){0,3}\b/g
const SPECIAL_CHINESE_PHRASE_PATTERN = /[\u4e00-\u9fff]{2,16}(?:海报|月卡|直充|促销|信息图|流程图|测试集|模型|结论|工作流|仪表盘|朋友圈|社群|微信|土区|官方|免费|公告|调试|预览)/g
const SCENE_PHRASE_PATTERN = /(?:微信聊天|朋友圈传播|朋友圈|社群传播|微信传播|社群)/g

export function sanitizeImageFileNamePart(value: string, maxLength = 80): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, maxLength)
}

export function extractPromptKeywords(prompt: string, maxKeywords = 4): string[] {
  const raw = normalizePrompt(prompt)
  if (!raw) return []

  const keywords: string[] = []
  const seen = new Set<string>()

  const pushCandidate = (candidate: string) => {
    for (const keyword of explodeCandidate(candidate)) {
      const normalized = normalizeKeyword(keyword)
      if (!normalized) continue
      const dedupeKey = normalized.toLowerCase()
      if (seen.has(dedupeKey)) continue
      if ([...seen].some((existing) => existing.includes(dedupeKey) || dedupeKey.includes(existing))) continue
      seen.add(dedupeKey)
      keywords.push(normalized)
      if (keywords.length >= maxKeywords) return true
    }
    return false
  }

  const labelCandidates: string[] = []
  collectMatches(raw, LABEL_VALUE_PATTERN, labelCandidates)
  for (const candidate of labelCandidates) {
    if (pushCandidate(candidate)) return keywords
  }

  const quotedCandidates: string[] = []
  collectMatches(raw, QUOTED_VALUE_PATTERN, quotedCandidates)
  for (const candidate of quotedCandidates) {
    for (const part of splitStructuredPhrase(candidate)) {
      if (pushCandidate(part)) return keywords
    }
  }

  const priceCandidates: string[] = []
  collectMatches(raw, PRICE_PATTERN, priceCandidates)
  for (const candidate of priceCandidates) {
    if (pushCandidate(candidate)) return keywords
  }

  const sceneCandidates: string[] = []
  collectMatches(raw, SCENE_PHRASE_PATTERN, sceneCandidates)
  for (const candidate of sceneCandidates) {
    if (pushCandidate(candidate)) return keywords
  }

  const hasStructuredHint = labelCandidates.length > 0 || quotedCandidates.length > 0
  if (hasStructuredHint && keywords.length >= 3) return keywords

  const asciiCandidates: string[] = []
  collectMatches(raw, ASCII_PHRASE_PATTERN, asciiCandidates)
  for (const candidate of asciiCandidates) {
    if (pushCandidate(candidate)) return keywords
  }

  for (const token of tokenizePrompt(raw)) {
    if (pushCandidate(token)) return keywords
  }

  return keywords
}

export function buildPromptFileNameBase(
  prompt: string,
  options?: { fallback?: string; suffix?: string; maxKeywords?: number; maxLength?: number },
): string {
  const fallback = sanitizeImageFileNamePart(options?.fallback || 'image', options?.maxLength || 80) || 'image'
  const keywords = extractPromptKeywords(prompt, options?.maxKeywords || 4)
  let base = keywords.length > 0 ? keywords.join('-') : fallback
  if (options?.suffix) {
    const suffix = normalizeKeyword(options.suffix)
    if (suffix) base = `${base}-${suffix}`
  }
  return sanitizeImageFileNamePart(base, options?.maxLength || 80) || fallback
}

export function buildTaskFileNameBase(
  task: Pick<TaskRecord, 'id' | 'prompt'>,
  options?: { fallbackPrefix?: string; suffix?: string; maxKeywords?: number; maxLength?: number },
): string {
  const fallbackPrefix = options?.fallbackPrefix || 'task'
  const fallback = `${fallbackPrefix}-${task.id}`
  return buildPromptFileNameBase(task.prompt, {
    fallback,
    suffix: options?.suffix,
    maxKeywords: options?.maxKeywords,
    maxLength: options?.maxLength,
  })
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ').trim()
}

function collectMatches(input: string, pattern: RegExp, target: string[]) {
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[0]
    if (value) target.push(value)
  }
}

function tokenizePrompt(prompt: string): string[] {
  const cleaned = prompt
    .replace(/[「」“”"'‘’()（）【】\[\],，。；;！!？?]/g, ' ')
    .replace(/\s+/g, ' ')

  return cleaned
    .split(' ')
    .map((part) => stripLeadingPhrases(part.trim()))
    .filter(Boolean)
}

function stripLeadingPhrases(value: string): string {
  let next = value
  let changed = true
  while (changed && next) {
    changed = false
    for (const phrase of LEADING_PHRASES) {
      if (next.startsWith(phrase) && next.length > phrase.length) {
        next = next.slice(phrase.length)
        changed = true
      }
    }
  }
  return next.trim()
}

function explodeCandidate(value: string): string[] {
  const cleaned = value.trim()
  if (!cleaned) return []
  if (/[A-Za-z0-9：:]/.test(cleaned)) return [cleaned]
  const specialMatches = cleaned.match(SPECIAL_CHINESE_PHRASE_PATTERN)
  if (specialMatches && specialMatches.length > 0) return specialMatches
  return [cleaned]
}

function normalizeKeyword(value: string): string {
  let next = sanitizeImageFileNamePart(value, 40)
  if (!next) return ''

  next = next
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .replace(/^(?:一张|一个|生成|请|帮我|做个|做一张)+/g, '')
    .trim()

  if (!next) return ''
  next = next.replace(/^[^A-Za-z0-9\u4e00-\u9fff]+|[^A-Za-z0-9\u4e00-\u9fff]+$/g, '')
  next = next.replace(/[：:，,。；;]+/g, '-')
  if (GENERIC_STOP_TOKENS.has(next.toLowerCase())) return ''
  if (/^[\d.]+$/.test(next)) return ''

  if (/[A-Za-z0-9]/.test(next)) {
    next = next.replace(/\s+/g, '-')
  } else {
    next = next.replace(/\s+/g, '')
  }

  if (next.length < 2 && !/\d/.test(next)) return ''
  return sanitizeImageFileNamePart(next, 40)
}

function splitStructuredPhrase(value: string): string[] {
  return value
    .split(/[：:，,。；;]/)
    .map((part) => part.trim())
    .filter(Boolean)
}
