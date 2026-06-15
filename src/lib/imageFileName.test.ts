import { describe, expect, it } from 'vitest'
import { buildPromptFileNameBase, buildTaskFileNameBase, extractPromptKeywords } from './imageFileName'

describe('imageFileName', () => {
  it('extracts mixed Chinese and English keywords from prompt', () => {
    const prompt = `生成一张适合微信聊天、朋友圈、社群传播的正方形促销海报
顶部大字：GPT Plus
主标题：iOS土区直充月卡
底部超大价格：20刀`
    expect(extractPromptKeywords(prompt)).toEqual(['GPT-Plus', 'iOS土区直充月卡', '20刀', '微信聊天'])
  })

  it('builds readable file name base from prompt', () => {
    const prompt = '生成一张中文信息图，标题为「8项实测结论：Claude Fable 5 很快，GPT-5.5 更稳」'
    expect(buildPromptFileNameBase(prompt)).toBe('8项实测结论-Claude-Fable-5-很快-GPT-5.5-更稳')
  })

  it('falls back to task id when prompt is empty', () => {
    expect(buildTaskFileNameBase({ id: 'abc123', prompt: '   ' })).toBe('task-abc123')
  })

  it('supports suffix without breaking base name', () => {
    const prompt = '主标题：iOS土区官方直充月卡\n底部超大价格：20刀'
    expect(buildPromptFileNameBase(prompt, { suffix: 'preview-1' })).toBe('iOS土区官方直充月卡-20刀-preview-1')
  })
})
