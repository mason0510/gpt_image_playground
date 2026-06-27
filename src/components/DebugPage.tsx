import { useEffect, useMemo, useState } from 'react'
import { initStore, useStore } from '../store'
import { getActiveApiProfile } from '../lib/apiProfiles'
import { createApiAuthorizationHeaders, LIMITED_FREE_API_KEY_SENTINEL } from '../lib/apiKeyMode'
import { getAllAgentConversations, getAllImageIds, getAllTasks } from '../lib/db'
import type { TaskRecord } from '../types'

type QuotaPayload = {
  mode?: string
  quota?: {
    day?: string
    limit?: number
    used?: number
    remaining?: number
    limit_4k?: number
    used_4k?: number
    remaining_4k?: number
  }
  timestamp?: string
}

type StorageEstimate = {
  quota?: number
  usage?: number
}

type DebugSnapshot = {
  refreshedAt: string
  quotaStatus: 'idle' | 'loading' | 'ok' | 'error'
  quota?: QuotaPayload
  quotaError?: string
  storage?: StorageEstimate
  taskCount: number
  imageCount: number
  agentConversationCount: number
  runningTasks: TaskRecord[]
  latestTasks: TaskRecord[]
  localStorageKeys: string[]
  serviceWorker?: string
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value ?? NaN)) return '未知'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value ?? 0
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatTime(value?: number | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function maskText(value: string, head = 10, tail = 6) {
  if (!value) return '-'
  if (value.length <= head + tail + 3) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function getDeviceId() {
  try {
    return window.localStorage.getItem('imagination-space-limited-free-device-id') || ''
  } catch {
    return ''
  }
}

function getLocalStorageKeys() {
  try {
    return Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) || '')
      .filter(Boolean)
      .sort()
  } catch {
    return []
  }
}

async function getServiceWorkerState() {
  if (!('serviceWorker' in navigator)) return '不支持'
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  if (!registration) return '未注册'
  const controller = navigator.serviceWorker.controller ? 'controller=active' : 'controller=none'
  const waiting = registration.waiting ? 'waiting=yes' : 'waiting=no'
  const active = registration.active?.state ? `active=${registration.active.state}` : 'active=none'
  return `${controller}, ${active}, ${waiting}`
}

function sanitizeTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    prompt: task.prompt.length > 160 ? `${task.prompt.slice(0, 160)}…` : task.prompt,
    rawResponsePayload: task.rawResponsePayload ? `${task.rawResponsePayload.slice(0, 400)}${task.rawResponsePayload.length > 400 ? '…' : ''}` : undefined,
  }
}

async function loadDebugSnapshot(): Promise<DebugSnapshot> {
  const [tasks, imageIds, conversations, storage, serviceWorker] = await Promise.all([
    getAllTasks().catch(() => [] as TaskRecord[]),
    getAllImageIds().catch(() => [] as string[]),
    getAllAgentConversations().catch(() => []),
    navigator.storage?.estimate?.().catch(() => undefined),
    getServiceWorkerState(),
  ])

  const sortedTasks = [...tasks].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return {
    refreshedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    quotaStatus: 'idle',
    storage,
    taskCount: tasks.length,
    imageCount: imageIds.length,
    agentConversationCount: conversations.length,
    runningTasks: sortedTasks.filter((task) => task.status === 'running').slice(0, 10).map(sanitizeTask),
    latestTasks: sortedTasks.slice(0, 12).map(sanitizeTask),
    localStorageKeys: getLocalStorageKeys(),
    serviceWorker,
  }
}

async function fetchQuota(): Promise<QuotaPayload> {
  const headers = createApiAuthorizationHeaders(LIMITED_FREE_API_KEY_SENTINEL, true)
  const response = await fetch('/api-proxy/v1/limited-free/quota', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
  return JSON.parse(text) as QuotaPayload
}

export default function DebugPage() {
  const settings = useStore((s) => s.settings)
  const appMode = useStore((s) => s.appMode)
  const tasksInMemory = useStore((s) => s.tasks)
  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    setLoading(true)
    const base = await loadDebugSnapshot()
    setSnapshot({ ...base, quotaStatus: 'loading' })
    try {
      const quota = await fetchQuota()
      setSnapshot({ ...base, quotaStatus: 'ok', quota })
    } catch (error) {
      setSnapshot({ ...base, quotaStatus: 'error', quotaError: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    initStore()
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const deviceId = getDeviceId()
  const persistKey = 'gpt-image-playground'
  const indexedDbName = 'gpt-image-playground'

  return (
    <div className="min-h-screen bg-[#080b12] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/30 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-blue-300">Imagination Space Debug</div>
            <h1 className="mt-1 text-2xl font-bold">绘想空间调试面板</h1>
            <p className="mt-2 text-sm text-slate-400">给用户排查用：本机保存位置、免费额度、运行中任务、最近错误、Service Worker 状态。</p>
          </div>
          <div className="flex gap-2">
            <a className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/15" href="/">回主页面</a>
            <button className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-60" onClick={() => void refresh()} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <InfoCard title="免费额度" value={snapshot?.quotaStatus === 'ok' ? `${snapshot.quota?.quota?.remaining ?? '-'} / ${snapshot.quota?.quota?.limit ?? '-'}` : snapshot?.quotaStatus === 'error' ? '读取失败' : '读取中'} detail={snapshot?.quota?.quota?.day ? `日期 ${snapshot.quota.quota.day}` : snapshot?.quotaError} tone={snapshot?.quotaStatus === 'error' ? 'red' : 'blue'} />
          <InfoCard title="任务 / 图片" value={`${snapshot?.taskCount ?? tasksInMemory.length} / ${snapshot?.imageCount ?? '-'}`} detail="IndexedDB tasks / images" />
          <InfoCard title="本地存储" value={`${formatBytes(snapshot?.storage?.usage)} / ${formatBytes(snapshot?.storage?.quota)}`} detail="navigator.storage.estimate" />
          <InfoCard title="当前模式" value={appMode} detail={`profile=${activeProfile.name || activeProfile.provider}`} />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Panel title="当前用户 / 保存位置">
            <KeyValue label="用户识别方式" value="浏览器本地 device id + 浏览器/设备特征，发送到后端做 limited-free 额度键" />
            <KeyValue label="Device ID localStorage key" value="imagination-space-limited-free-device-id" mono />
            <KeyValue label="Device ID" value={maskText(deviceId)} mono />
            <KeyValue label="Zustand localStorage key" value={persistKey} mono />
            <KeyValue label="IndexedDB" value={`${indexedDbName} / stores: tasks, images, thumbnails, agentConversations`} mono />
            <KeyValue label="Service Worker" value={snapshot?.serviceWorker || '-'} />
            <KeyValue label="刷新时间" value={snapshot?.refreshedAt || '-'} />
          </Panel>

          <Panel title="免费额度 readback">
            {snapshot?.quotaStatus === 'ok' ? (
              <pre className="max-h-72 overflow-auto rounded-2xl bg-black/35 p-4 text-xs text-emerald-100">{JSON.stringify(snapshot.quota, null, 2)}</pre>
            ) : (
              <div className={`rounded-2xl p-4 text-sm ${snapshot?.quotaStatus === 'error' ? 'bg-red-500/10 text-red-200' : 'bg-white/5 text-slate-300'}`}>
                {snapshot?.quotaError || '正在读取 /api-proxy/v1/limited-free/quota …'}
              </div>
            )}
          </Panel>
        </section>

        <Panel title={`运行中任务 (${snapshot?.runningTasks.length ?? 0})`}>
          <TaskTable tasks={snapshot?.runningTasks ?? []} empty="当前没有 running 任务" />
        </Panel>

        <Panel title="最近任务 / 最近错误">
          <TaskTable tasks={snapshot?.latestTasks ?? []} empty="暂无任务记录" />
        </Panel>

        <Panel title="localStorage keys">
          <div className="flex flex-wrap gap-2">
            {(snapshot?.localStorageKeys ?? []).map((key) => (
              <span key={key} className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-xs text-slate-300">{key}</span>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}

function InfoCard({ title, value, detail, tone = 'slate' }: { title: string; value: string; detail?: string; tone?: 'slate' | 'blue' | 'red' }) {
  const toneClass = tone === 'red' ? 'text-red-200' : tone === 'blue' ? 'text-blue-200' : 'text-slate-100'
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs text-slate-400">{title}</div>
      <div className={`mt-2 text-2xl font-bold ${toneClass}`}>{value}</div>
      {detail && <div className="mt-2 break-words text-xs text-slate-500">{detail}</div>}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
      <h2 className="mb-4 text-base font-semibold text-slate-100">{title}</h2>
      {children}
    </section>
  )
}

function KeyValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 border-b border-white/5 py-2 text-sm last:border-b-0 sm:grid-cols-[180px_1fr]">
      <div className="text-slate-500">{label}</div>
      <div className={`break-words text-slate-200 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  )
}

function TaskTable({ tasks, empty }: { tasks: TaskRecord[]; empty: string }) {
  if (tasks.length === 0) return <div className="rounded-2xl bg-white/[0.03] p-4 text-sm text-slate-500">{empty}</div>
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="px-3 py-2">时间</th>
            <th className="px-3 py-2">状态</th>
            <th className="px-3 py-2">尺寸</th>
            <th className="px-3 py-2">模型</th>
            <th className="px-3 py-2">耗时</th>
            <th className="px-3 py-2">提示词 / 错误</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-t border-white/5 align-top">
              <td className="whitespace-nowrap px-3 py-2 text-slate-400">{formatTime(task.createdAt)}</td>
              <td className="px-3 py-2"><span className={`rounded-full px-2 py-1 ${task.status === 'error' ? 'bg-red-500/10 text-red-200' : task.status === 'running' ? 'bg-amber-500/10 text-amber-200' : 'bg-emerald-500/10 text-emerald-200'}`}>{task.status}</span></td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-300">{task.params?.size || '-'}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-400">{task.apiModel || '-'}</td>
              <td className="whitespace-nowrap px-3 py-2 text-slate-400">{task.elapsed ? `${Math.round(task.elapsed / 1000)}s` : '-'}</td>
              <td className="max-w-xl px-3 py-2 text-slate-300">
                <div>{task.prompt}</div>
                {task.error && <div className="mt-1 whitespace-pre-wrap text-red-200">{task.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
