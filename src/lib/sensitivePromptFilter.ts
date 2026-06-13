export interface SensitivePromptCheckResult {
  blocked: boolean
  matches: string[]
}

// 前端兜底拦截：只拦截国家领导人 / 政治公众人物形象生成相关显性敏感词。
// 不把「美女」「少妇」这类普通人物描述词列入，避免误伤正常图片创作。
const SENSITIVE_PROMPT_TERMS = [
  // 通用政治身份
  '国家领导人',
  '國家領導人',
  '党和国家领导人',
  '黨和國家領導人',
  '最高领导人',
  '最高領導人',
  '国家主席',
  '國家主席',
  '总书记',
  '總書記',
  '政治人物肖像',
  '政治人物形象',
  '政治领袖',
  '政治領袖',
  '国家元首',
  '國家元首',
  // 常见现任/前任国家领导人姓名；用于避免直接生成真人政治人物形象。
  '习近平',
  '習近平',
  'xi jinping',
  '李强',
  '李強',
  '赵乐际',
  '趙樂際',
  '王沪宁',
  '王滬寧',
  '蔡奇',
  '丁薛祥',
  '李希',
  '特朗普',
  '川普',
  'trump',
  '拜登',
  'biden',
  '普京',
  'putin',
  '泽连斯基',
  '澤連斯基',
  'zelensky',
  '马克龙',
  '馬克龍',
  'macron',
  '金正恩',
  'kim jong un',
]

const NORMALIZE_REMOVABLE_RE = /[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f"'“”‘’`´.,，。:：;；!！?？、/\\|()[\]{}<>《》【】_\-—·~～+=*&^%$#@]+/gu

export function normalizePromptForSensitiveCheck(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .toLowerCase()
    .replace(NORMALIZE_REMOVABLE_RE, '')
}

export function checkSensitivePrompt(prompt: string): SensitivePromptCheckResult {
  const normalizedPrompt = normalizePromptForSensitiveCheck(prompt)
  const matches = SENSITIVE_PROMPT_TERMS.filter((term) => normalizedPrompt.includes(normalizePromptForSensitiveCheck(term)))
  return {
    blocked: matches.length > 0,
    matches: Array.from(new Set(matches)),
  }
}

export function formatSensitivePromptMessage(result: SensitivePromptCheckResult): string {
  const preview = result.matches.slice(0, 3).join('、')
  return preview
    ? `提示词包含敏感词「${preview}」，请调整后再提交。`
    : '提示词包含敏感内容，请调整后再提交。'
}
