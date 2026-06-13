#!/usr/bin/env node
// 浏览器请求 harness：用独立 Chrome profile + CDP 抓真实前端请求链。
// 不使用 Playwright/Puppeteer；不打印 Authorization / apiKey / b64 图片。

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 180_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs(argv) {
  const args = {
    url: '',
    apiKeyFile: '',
    prompt: '生成一张极简蓝色圆点图标，纯色背景，浏览器 harness 验收',
    model: 'gpt-5.4',
    apiMode: 'responses',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepOpen: false,
    chromePath: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--url') args.url = argv[++i] ?? ''
    else if (item === '--api-key-file') args.apiKeyFile = argv[++i] ?? ''
    else if (item === '--prompt') args.prompt = argv[++i] ?? args.prompt
    else if (item === '--model') args.model = argv[++i] ?? args.model
    else if (item === '--api-mode') args.apiMode = argv[++i] ?? args.apiMode
    else if (item === '--timeout-ms') args.timeoutMs = Number(argv[++i] ?? DEFAULT_TIMEOUT_MS)
    else if (item === '--chrome') args.chromePath = argv[++i] ?? ''
    else if (item === '--keep-open') args.keepOpen = true
    else if (item === '-h' || item === '--help') {
      console.log(`Usage: node scripts/browser-request-harness.mjs --url <page-url> --api-key-file <json-or-text> [--model gpt-5.4] [--prompt text]\n\nThe harness launches an isolated Chrome profile, injects apiKey via URL settings, clicks the real UI, and prints redacted Network evidence.`)
      process.exit(0)
    }
  }
  if (!args.url) throw new Error('missing --url')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 5_000) args.timeoutMs = DEFAULT_TIMEOUT_MS
  return args
}

function readApiKey(file) {
  if (!file) return ''
  const raw = readFileSync(file, 'utf8').trim()
  try {
    const parsed = JSON.parse(raw)
    return String(parsed.OPENAI_API_KEY || parsed.apiKey || parsed.key || '').trim()
  } catch {
    return raw
  }
}

function redactUrl(input) {
  try {
    const url = new URL(input)
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|authorization|password/i.test(key)) url.searchParams.set(key, '***REDACTED***')
    }
    return url.toString()
  } catch {
    return String(input).replace(/(apiKey=)[^&\s]+/gi, '$1***REDACTED***')
  }
}

function sanitizeBody(body) {
  if (!body) return ''
  let text = String(body)
  text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, 'data:image/***B64_REDACTED***')
  text = text.replace(/\"b64_json\"\s*:\s*\"[^\"]{40,}\"/g, '\"b64_json\":\"***B64_REDACTED***\"')
  text = text.replace(/\"(?:result|image_url|url)\"\s*:\s*\"(?:data:image\/[^\"]+|[A-Za-z0-9+/=]{160,})\"/g, (m) => m.replace(/:\s*\".*\"$/, ':\"***IMAGE_REDACTED***\"'))
  text = text.replace(/\b[A-Za-z0-9+/]{240,}={0,2}\b/g, '***LONG_B64_REDACTED***')
  text = text.replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***REDACTED***')
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

function sanitizeDeep(value, depth = 0) {
  if (depth > 8) return '***DEPTH_LIMIT***'
  if (typeof value === 'string') return sanitizeBody(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item, depth + 1)]))
}

function summarizeResponseBody(body) {
  const raw = String(body || '')
  const sanitized = sanitizeBody(raw)
  return {
    bodyLength: raw.length,
    preview: sanitized,
    hasImageGenerationCompleted: /image_generation_call\.completed/i.test(raw),
    hasResponseCompleted: /response\.completed/i.test(raw) || /\"status\"\s*:\s*\"completed\"/i.test(raw),
    hasImageGenerationCall: /image_generation_call/i.test(raw),
    hasDataImage: /data:image\//i.test(raw),
    hasLongBase64: /\b[A-Za-z0-9+/]{240,}={0,2}\b/.test(raw),
  }
}

function chromeExecutable(explicit) {
  const candidates = [
    explicit,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('Chrome executable not found; pass --chrome <path>')
  return found
}

async function waitForPortFile(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort')
  for (let i = 0; i < 80; i += 1) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').trim().split('\n')
      if (port) return Number(port)
    }
    await sleep(250)
  }
  throw new Error('Chrome DevToolsActivePort not created')
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl)
      this.ws.onopen = resolve
      this.ws.onerror = () => reject(new Error('CDP websocket error'))
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: fail } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? fail(new Error(msg.error.message)) : ok(msg.result)
          return
        }
        if (msg.method && this.handlers.has(msg.method)) {
          for (const handler of this.handlers.get(msg.method)) handler(msg.params || {})
        }
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timeoutMs = method === 'Runtime.evaluate' || method === 'Network.getResponseBody' || method === 'Page.navigate' ? 120_000 : 20_000
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
    })
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method).add(handler)
  }
  close() { try { this.ws?.close() } catch {} }
}

function appendUrlSettings(rawUrl, apiKey, model, apiMode) {
  const url = new URL(rawUrl)
  if (apiKey) url.searchParams.set('apiKey', apiKey)
  url.searchParams.set('apiMode', apiMode)
  url.searchParams.set('model', model)
  url.searchParams.set('streamImages', 'false')
  return url.toString()
}

function uiTreeExpression() {
  return `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const rectOf = (el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const brief = (el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      aria: el.getAttribute('aria-label') || null,
      title: el.getAttribute('title') || null,
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      rect: rectOf(el),
    })
    const buttons = [...document.querySelectorAll('button')].filter(visible).map(brief)
    const inputs = [...document.querySelectorAll('textarea,input,[contenteditable]')].filter(visible).map(brief)
    const images = [...document.images].filter(visible).map((img) => ({
      tag: 'img',
      alt: img.alt || null,
      srcKind: /^data:image\\//.test(img.currentSrc || img.src || '') ? 'data-image' : /^blob:/.test(img.currentSrc || img.src || '') ? 'blob' : 'url',
      rect: rectOf(img),
    }))
    const landmarks = {
      hasSidebar: Boolean([...document.querySelectorAll('aside')].find(visible)),
      hasMain: Boolean([...document.querySelectorAll('main')].find(visible)),
      title: document.title,
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
    }
    const assertions = [
      { name: 'brandName', ok: /绘想空间/.test(landmarks.bodyText) && /Imagination Space/.test(landmarks.bodyText) },
      { name: 'leftSidebar', ok: landmarks.hasSidebar },
      { name: 'mainWorkspace', ok: landmarks.hasMain || /描述你想生成的图片/.test(landmarks.bodyText) },
      { name: 'galleryEntry', ok: buttons.some((b) => /画廊/.test(b.text + b.aria)) },
      { name: 'agentEntry', ok: buttons.some((b) => /Agent/.test(b.text + b.aria)) },
      { name: 'apiKeyEntry', ok: buttons.some((b) => /API Key|设置|配置/.test(b.text + b.aria)) },
      { name: 'promptInput', ok: inputs.some((i) => /描述你想生成的图片/.test(i.aria || '')) },
      { name: 'submitButton', ok: buttons.some((b) => /生成图像/.test(b.text + b.aria)) },
      { name: 'recentImagesSection', ok: /最近图片/.test(landmarks.bodyText) },
      { name: 'trashButtonWhenRecentExists', ok: /暂无图片任务/.test(landmarks.bodyText) ? true : buttons.some((b) => /删除最近图片/.test(b.aria || b.title || b.text)) },
    ]
    return { viewport: { w: window.innerWidth, h: window.innerHeight }, landmarks, assertions, buttons: buttons.slice(0, 80), inputs, images: images.slice(0, 20) }
  })()`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = readApiKey(args.apiKeyFile)
  const keyHash = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8) : null
  const userDataDir = mkdtempSync(join(tmpdir(), 'gpt-image-harness-chrome-'))
  const chrome = chromeExecutable(args.chromePath)
  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--headless=new',
    '--disable-gpu',
    '--window-size=1440,1000',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    'about:blank',
  ]
  const child = spawn(chrome, chromeArgs, { stdio: 'ignore', detached: false })
  const startedAt = Date.now()
  const evidence = []
  const consoleEvents = []
  const sseEvents = []
  const loadingFinished = new Set()
  let cdp
  let pageRequest = null
  let completed = false
  let completionReason = null
  let imageCompletedCount = 0
  let responseCompletedCount = 0
  try {
    const port = await waitForPortFile(userDataDir)
    const version = await jsonFetch(`http://127.0.0.1:${port}/json/version`)
    const pages = await jsonFetch(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find((item) => item.type === 'page') ?? pages[0]
    cdp = new CDP(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Network.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    const requestMap = new Map()
    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p.request?.url || ''
      const hit = /\/api-proxy\/v1\/(responses|images|models)|\/v1\/(responses|images|models)|api\.openai\.com|sub-lb\.tap365\.org/i.test(url)
      const row = {
        phase: 'request',
        requestId: p.requestId,
        method: p.request?.method,
        url: redactUrl(url),
        type: p.type,
        postData: sanitizeBody(p.request?.postData || ''),
      }
      requestMap.set(p.requestId, row)
      if (hit) evidence.push(row)
    })
    cdp.on('Network.responseReceived', async (p) => {
      const req = requestMap.get(p.requestId)
      const url = p.response?.url || req?.url || ''
      if (!req && !/\/api-proxy\/v1\/(responses|images|models)|\/v1\/(responses|images|models)|api\.openai\.com|sub-lb\.tap365\.org/i.test(url)) return
      const row = {
        phase: 'response',
        requestId: p.requestId,
        status: p.response?.status,
        url: redactUrl(url),
        mimeType: p.response?.mimeType,
      }
      evidence.push(row)
      if (/\/responses|\/images/i.test(url)) {
        pageRequest = {
          requestId: p.requestId,
          status: p.response?.status,
          url: redactUrl(url),
          mimeType: p.response?.mimeType || null,
        }
      }
    })
    cdp.on('Network.eventSourceMessageReceived', (p) => {
      const eventName = String(p.eventName || '')
      const data = sanitizeBody(p.eventData || '')
      const row = {
        eventName,
        dataPreview: data,
        requestId: p.requestId,
      }
      sseEvents.push(row)
      if (/image_generation_call\.completed/i.test(eventName) || /image_generation_call\.completed/i.test(data)) {
        imageCompletedCount += 1
        completed = true
        completionReason = completionReason || 'image_generation_call.completed'
      }
      if (/response\.completed/i.test(eventName) || /"type"\s*:\s*"response\.completed"/i.test(data) || /"status"\s*:\s*"completed"/i.test(data)) {
        responseCompletedCount += 1
        completed = true
        completionReason = completionReason || 'response.completed'
      }
    })
    cdp.on('Network.loadingFinished', (p) => {
      loadingFinished.add(p.requestId)
      if (pageRequest?.requestId === p.requestId && Number(pageRequest.status) < 400) {
        completed = true
        completionReason = completionReason || 'network.loadingFinished'
      }
    })
    cdp.on('Network.loadingFailed', (p) => {
      const req = requestMap.get(p.requestId)
      if (!req) return
      const row = { phase: 'loadingFailed', requestId: p.requestId, url: redactUrl(req.url), errorText: p.errorText, blockedReason: p.blockedReason || null, canceled: Boolean(p.canceled) }
      evidence.push(row)
      if (/\/responses|\/images/i.test(req.url)) {
        const isSameSuccessfulRequest = pageRequest?.requestId === p.requestId && Number(pageRequest?.status) > 0 && Number(pageRequest?.status) < 400
        if (p.canceled && (completed || isSameSuccessfulRequest)) {
          pageRequest = { ...pageRequest, canceledAfterSuccess: true, errorText: p.errorText, blockedReason: p.blockedReason || null }
        } else {
          pageRequest = { requestId: p.requestId, failed: true, url: redactUrl(req.url), errorText: p.errorText, blockedReason: p.blockedReason || null }
        }
      }
    })
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
      if (/api-trace|Failed to fetch|请求未发出|error/i.test(text)) consoleEvents.push({ type: p.type, text: sanitizeBody(text) })
    })

    const targetUrl = appendUrlSettings(args.url, apiKey, args.model, args.apiMode)
    await cdp.send('Page.navigate', { url: targetUrl })
    const pageReadyDeadline = Date.now() + 45_000
    let readySnapshot = null
    while (Date.now() < pageReadyDeadline) {
      const ready = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const text = document.body.innerText || ''
          const input = [...document.querySelectorAll('[contenteditable], textarea, input')].find((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          })
          const promptInput = [...document.querySelectorAll('[contenteditable], textarea, input')].find((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && /描述你想生成的图片/.test(el.getAttribute('aria-label') || '')
          })
          return { ready: Boolean(promptInput) && /生成图像|API Key|画廊/.test(text), text: text.slice(0, 500), inputCount: document.querySelectorAll('[contenteditable], textarea, input').length, hasPromptInput: Boolean(promptInput), firstInputAria: input?.getAttribute('aria-label') || '' }
        })()`,
      })
      readySnapshot = ready.result?.value
      if (readySnapshot?.ready) break
      await sleep(500)
    }
    const domResult = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const done = (value) => resolve(value)
        const prompt = ${JSON.stringify(args.prompt)}
        function visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
        const allInputs = [...document.querySelectorAll('[contenteditable], textarea, input')].filter(visible)
        const input = allInputs.find((el) => /描述你想生成的图片/.test(el.getAttribute('aria-label') || ''))
          || allInputs.filter((el) => el.matches('[contenteditable]')).sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0]
        if (!input) return done({ ok: false, stage: 'find-input', title: document.title, readySnapshot: ${JSON.stringify(null)}, text: document.body.innerText.slice(0, 500) })
        input.focus()
        if (input.matches('textarea,input')) {
          input.value = prompt
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          document.execCommand('selectAll', false, null)
          document.execCommand('insertText', false, prompt)
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }))
        }
        setTimeout(() => {
          const buttons = [...document.querySelectorAll('button')].filter(visible)
          const submit = buttons
            .filter((b) => !b.disabled && ((b.getAttribute('aria-label') || '').includes('生成图像') || /生成图像/.test(b.innerText || '')))
            .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0]
          if (!submit) return done({ ok: false, stage: 'find-submit', text: document.body.innerText.slice(0, 800) })
          submit.click()
          done({ ok: true, stage: 'clicked', title: document.title, buttonLabel: submit.getAttribute('aria-label') || submit.innerText || '', inputTag: input.tagName, inputAria: input.getAttribute('aria-label') || '' })
        }, 800)
      })`,
    })

    const deadline = Date.now() + args.timeoutMs
    let domCompletion = null
    while (Date.now() < deadline) {
      if (completed) break
      if (pageRequest?.failed) break
      if (pageRequest && Date.now() % 5_000 < 1_100) {
        const check = await cdp.send('Runtime.evaluate', {
          returnByValue: true,
          expression: `(() => {
            const text = document.body.innerText || ''
            const doneText = /生成完成|下载原图|下载图片|重新生成|收藏任务|编辑任务|完成/.test(text)
            const hasImage = [...document.images].some((img) => {
              const src = img.currentSrc || img.src || ''
              const r = img.getBoundingClientRect()
              return r.width > 80 && r.height > 80 && (/^data:image\\//.test(src) || /^blob:/.test(src) || /\\/assets\\//.test(src) === false)
            })
            const hasRunning = /生成中|正在生成|流式预览/.test(text)
            return { doneText, hasImage, hasRunning, textPreview: text.slice(0, 500) }
          })()`,
        })
        const value = check.result?.value
        if (value?.doneText && value?.hasImage && !value?.hasRunning) {
          domCompletion = value
          completed = true
          completionReason = completionReason || 'dom.done-image'
          break
        }
      }
      await sleep(1000)
    }

    let responseBody = null
    if (pageRequest?.requestId && pageRequest.status && pageRequest.status >= 400) {
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: pageRequest.requestId })
        responseBody = summarizeResponseBody(body.body || '')
      } catch (err) {
        responseBody = `<<getResponseBody failed: ${err.message}>>`
      }
    }
    if (pageRequest?.requestId && Number(pageRequest.status) < 400 && loadingFinished.has(pageRequest.requestId)) {
      responseBody = {
        skipped: true,
        reason: 'success body omitted to avoid logging image/base64 payload; completion is verified by DOM/UI checks',
      }
    }

    const uiTreeBeforeChecks = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: uiTreeExpression(),
    })
    const uiChecksEval = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(async (resolve) => {
        const checks = []
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const visible = (el) => {
          if (!el) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const textOf = () => document.body.innerText || ''
        const clickByText = async (pattern) => {
          const buttons = [...document.querySelectorAll('button')].filter(visible)
          const target = buttons.find((b) => pattern.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
          if (!target) return false
          target.click()
          await sleep(500)
          return true
        }
        const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail || '').slice(0, 180) })

        add('galleryNav', await clickByText(/画廊/), /画廊|最近图片|图片历史|收藏/.test(textOf()) ? 'gallery visible' : textOf().slice(0, 120))
        add('agentNav', await clickByText(/Agent/), /Agent|新对话|历史对话/.test(textOf()) ? 'agent visible' : textOf().slice(0, 120))
        add('settingsApi', await clickByText(/配置 API Key|设置|API Key/), /API Key|接口|Responses|配置/.test(textOf()) ? 'settings visible' : textOf().slice(0, 120))
        // 关闭设置弹窗，避免遮挡后续点击。
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(300)
        const closeBtn = [...document.querySelectorAll('button')].filter(visible).find((b) => /关闭|取消|×|✕/.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')))
        if (closeBtn) closeBtn.click()
        await sleep(500)

        await clickByText(/画廊/)
        const recentButton = [...document.querySelectorAll('button')].filter(visible).find((b) => /删除最近图片/.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
        add('recentDeleteButton', Boolean(recentButton), recentButton ? 'delete button visible' : textOf().slice(0, 160))
        if (recentButton) {
          recentButton.click()
          await sleep(500)
          add('recentDeleteConfirm', /删除任务|确定要删除这条最近图片记录吗/.test(textOf()), textOf().slice(0, 180))
          const cancel = [...document.querySelectorAll('button')].filter(visible).find((b) => /取消|关闭/.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')))
          if (cancel) cancel.click()
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(300)
        } else {
          add('recentDeleteConfirm', false, 'delete button not found')
        }
        const recentOpen = [...document.querySelectorAll('button')].filter(visible).find((b) => /极简蓝色圆点|完整 harness|harness 验收|最近图片|生成/.test(b.innerText || ''))
        if (recentOpen) {
          recentOpen.click()
          await sleep(500)
        }
        add('recentOpenDetail', /详情|下载|删除|重新生成|流式预览|生成完成/.test(textOf()), textOf().slice(0, 180))
        resolve(checks)
      })`,
    })
    const uiChecks = uiChecksEval.result?.value || []
    const uiTreeAfterChecks = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: uiTreeExpression(),
    })

    const summary = {
      ok: Boolean(pageRequest && !pageRequest.failed && Number(pageRequest.status) < 500 && completed),
      harness: 'chrome-cdp-isolated-profile',
      chrome: version.Browser,
      targetUrl: redactUrl(targetUrl),
      apiKey: apiKey ? { loaded: true, length: apiKey.length, sha8: keyHash } : { loaded: false },
      model: args.model,
      readySnapshot,
      domResult: domResult.result?.value,
      pageRequest,
      completed,
      completionReason,
      imageCompletedCount,
      responseCompletedCount,
      domCompletion,
      sseEvents: sseEvents.slice(-12),
      uiChecks,
      uiTree: {
        beforeChecks: uiTreeBeforeChecks.result?.value,
        afterChecks: uiTreeAfterChecks.result?.value,
      },
      responseBody,
      evidence,
      consoleEvents: consoleEvents.slice(-20),
      elapsedMs: Date.now() - startedAt,
    }
    console.log(JSON.stringify(sanitizeDeep(summary), null, 2))
    process.exitCode = summary.ok ? 0 : 2
  } finally {
    cdp?.close()
    if (!args.keepOpen) {
      try { child.kill('SIGTERM') } catch {}
    } else {
      console.error(`Chrome kept open: userDataDir=${userDataDir}`)
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2))
  process.exit(1)
})
