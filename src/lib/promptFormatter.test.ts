import { describe, expect, it } from 'vitest'
import { formatPromptForImageGeneration } from './promptFormatter'

describe('formatPromptForImageGeneration', () => {
  it('trims indentation and collapses excessive blank lines', () => {
    const result = formatPromptForImageGeneration('  第一行  \n\n\n    第二行\t\n')
    expect(result.prompt).toBe('第一行。第二行')
    expect(result.changed).toBe(true)
    expect(result.compactedWhitespace).toBe(true)
  })

  it('converts negative prompt section into plain image instruction', () => {
    const input = `生成一张海报。

负面提示词：

文字模糊、乱码、错字、文字变形、文字重叠、低质量、廉价山寨、过度拥挤、过度饱和、塑料质感、背景混乱、水印、人物、logo、像素化、卡通风`
    const result = formatPromptForImageGeneration(input)
    expect(result.convertedNegativePrompt).toBe(true)
    expect(result.prompt).toBe('生成一张海报。避免出现：文字模糊、乱码、错字、文字变形、文字重叠、低质量、廉价山寨、过度拥挤、过度饱和、塑料质感、背景混乱、水印、人物、logo、像素化、卡通风。')
  })

  it('keeps already clean prompts unchanged', () => {
    const input = '生成一张红金电商海报，标题清晰。'
    const result = formatPromptForImageGeneration(input)
    expect(result.prompt).toBe(input)
    expect(result.changed).toBe(false)
    expect(result.compactedWhitespace).toBe(false)
  })

  it('normalizes multi-paragraph poster prompts and folds negative prompts into avoid instructions', () => {
    const input = `  生成一张适合微信聊天、朋友圈、社群传播的正方形促销海报，1:1 构图，红金高端电商视觉风格，整体专业、醒目、有质感，但不要廉价山寨感。

      背景使用深红色与金色渐变，加入细腻金属光泽、光束、粒子高光和轻微舞台聚光效果。

      文字排版如下：
      顶部大字：GPT Plus
      中间小标题：优选渠道
      主标题：iOS土区直充月卡
      底部超大价格：20刀

      负面提示词：

      文字模糊、乱码、错字、文字变形、文字重叠、低质量、廉价山寨、水印、人物、logo`
    const result = formatPromptForImageGeneration(input)
    expect(result.convertedNegativePrompt).toBe(true)
    expect(result.prompt).not.toContain('负面提示词')
    expect(result.prompt).toContain('避免出现：文字模糊、乱码、错字、文字变形、文字重叠、低质量、廉价山寨、水印、人物、logo。')
    expect(result.prompt).toContain('主标题：iOS土区直充月卡')
    expect(result.prompt).toContain('顶部大字：GPT Plus')
    expect(result.prompt).not.toContain('\n')
    expect(result.compactedWhitespace).toBe(true)
  })

  it('removes spaces around Chinese text while preserving English phrase spaces', () => {
    const input = '顶部大字： GPT Plus \n 主标题： iOS 土区 直充 月卡 \n 底部价格： 20 刀'
    const result = formatPromptForImageGeneration(input)
    expect(result.prompt).toBe('顶部大字：GPT Plus；主标题：iOS土区直充月卡；底部价格：20刀')
  })
})
