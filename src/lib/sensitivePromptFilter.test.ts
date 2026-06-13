import { describe, expect, it } from 'vitest'
import { checkSensitivePrompt, normalizePromptForSensitiveCheck } from './sensitivePromptFilter'

describe('sensitivePromptFilter', () => {
  it('does not block ordinary beauty prompts', () => {
    expect(checkSensitivePrompt('汉服美女').blocked).toBe(false)
    expect(checkSensitivePrompt('汉服少妇美女').blocked).toBe(false)
  })

  it('blocks national leader prompts', () => {
    const result = checkSensitivePrompt('设计国家领导人的宣传海报')
    expect(result.blocked).toBe(true)
    expect(result.matches).toContain('国家领导人')
  })

  it('normalizes spaces and punctuation to reduce simple bypasses', () => {
    expect(checkSensitivePrompt('设计 国-家 领 导 人 形象').blocked).toBe(true)
    expect(normalizePromptForSensitiveCheck('Ｘｉ Ｊｉｎｐｉｎｇ')).toBe('xijinping')
  })

  it('blocks common political public figure names', () => {
    expect(checkSensitivePrompt('生成习近平卡通头像').blocked).toBe(true)
    expect(checkSensitivePrompt('生成 Trump 风格肖像').blocked).toBe(true)
  })
})
