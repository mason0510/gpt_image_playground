export interface PromptFormatResult {
  prompt: string
  changed: boolean
  convertedNegativePrompt: boolean
  compactedWhitespace: boolean
}

function normalizePromptWhitespace(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[\t ]+$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeNegativePromptSection(prompt: string): { prompt: string; converted: boolean } {
  const lines = prompt.split('\n')
  const output: string[] = []
  const negativeItems: string[] = []
  let inNegativeSection = false
  let converted = false

  for (const line of lines) {
    const trimmed = line.trim()
    const headerMatch = trimmed.match(/^负面提示词\s*[:：]\s*(.*)$/)
    if (headerMatch) {
      converted = true
      inNegativeSection = true
      const inlineText = headerMatch[1]?.trim()
      if (inlineText) negativeItems.push(inlineText)
      continue
    }

    if (inNegativeSection) {
      if (!trimmed) continue
      negativeItems.push(trimmed.replace(/^[\-•*]\s*/, ''))
      continue
    }

    output.push(line)
  }

  if (!converted) return { prompt, converted: false }

  const negativeText = negativeItems
    .join('、')
    .replace(/[，,、\s]+/g, '、')
    .replace(/^、+|、+$/g, '')

  const nextPrompt = [
    output.join('\n').trim(),
    negativeText ? `避免出现：${negativeText}。` : '',
  ].filter(Boolean).join('\n\n')

  return { prompt: nextPrompt, converted: true }
}

function lineJoiner(previous: string, line: string): string {
  if (!previous) return line
  if (/[：:]$/.test(previous)) return `${previous}${line}`
  if (/[。！？!?；;]$/.test(previous)) return `${previous}${line}`
  return `${previous}；${line}`
}

function compactPromptStructure(prompt: string): string {
  const paragraphs = prompt.split(/\n{2,}/).map((paragraph) =>
    paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce(lineJoiner, ''),
  ).filter(Boolean)

  return paragraphs.reduce((combined, paragraph) => {
    if (!combined) return paragraph
    if (/[。！？!?；;]$/.test(combined)) return `${combined}${paragraph}`
    return `${combined}。${paragraph}`
  }, '')
}

function removeUnsafePromptSpaces(prompt: string): string {
  return prompt
    .replace(/\s+/g, ' ')
    .replace(/([：，。；、！？（）《》“”])\s+/g, '$1')
    .replace(/\s+([：，。；、！？（）《》“”])/g, '$1')
    .replace(/([\p{Script=Han}])\s+/gu, '$1')
    .replace(/\s+([\p{Script=Han}])/gu, '$1')
    .trim()
}

export function formatPromptForImageGeneration(prompt: string): PromptFormatResult {
  const whitespaceNormalized = normalizePromptWhitespace(prompt)
  const negativeNormalized = normalizeNegativePromptSection(whitespaceNormalized)
  const structureCompacted = compactPromptStructure(negativeNormalized.prompt)
  const formatted = removeUnsafePromptSpaces(structureCompacted)
  return {
    prompt: formatted,
    changed: formatted !== prompt,
    convertedNegativePrompt: negativeNormalized.converted,
    compactedWhitespace: formatted !== normalizePromptWhitespace(negativeNormalized.prompt),
  }
}
