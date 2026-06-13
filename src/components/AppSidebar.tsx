import { useMemo, type ReactNode } from 'react'
import { removeTask, useStore } from '../store'
import type { AgentConversation, TaskRecord } from '../types'
import { BrandMarkIcon, EditIcon, HistoryIcon, PhotoIcon, SettingsIcon, TrashIcon } from './icons'

function formatSidebarTime(ts: number) {
  const date = new Date(ts)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString([], sameYear ? { month: '2-digit', day: '2-digit' } : { year: '2-digit', month: '2-digit', day: '2-digit' })
}

function getConversationTitle(conversation: AgentConversation) {
  const title = conversation.title?.trim()
  if (title) return title
  const firstUserMessage = conversation.messages.find((message) => message.role === 'user')?.content.trim()
  return firstUserMessage || '新对话'
}

function getTaskTitle(task: TaskRecord) {
  return task.prompt.trim() || (task.status === 'running' ? '生成中任务' : '未命名图片')
}

function SidebarNavItem({ active, icon, title, subtitle, onClick }: {
  active?: boolean
  icon: ReactNode
  title: string
  subtitle?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors ${
        active
          ? 'bg-white text-black shadow-[0_10px_30px_rgba(255,255,255,0.12)]'
          : 'text-white/72 hover:bg-white/[0.08] hover:text-white'
      }`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${active ? 'bg-black text-white' : 'bg-white/[0.06] text-white/80 group-hover:bg-white/[0.1]'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold tracking-tight">{title}</span>
        {subtitle && <span className={`block truncate text-[11px] ${active ? 'text-black/55' : 'text-white/38'}`}>{subtitle}</span>}
      </span>
    </button>
  )
}

export default function AppSidebar() {
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const createConversation = useStore((s) => s.createAgentConversation)
  const conversations = useStore((s) => s.agentConversations)
  const activeConversationId = useStore((s) => s.activeAgentConversationId)
  const setActiveConversationId = useStore((s) => s.setActiveAgentConversationId)
  const tasks = useStore((s) => s.tasks)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setFilterFavorite = useStore((s) => s.setFilterFavorite)
  const setActiveFavoriteCollectionId = useStore((s) => s.setActiveFavoriteCollectionId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 14),
    [conversations],
  )
  const recentTasks = useMemo(
    () => [...tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8),
    [tasks],
  )

  const openGallery = () => {
    setFilterFavorite(false)
    setActiveFavoriteCollectionId(null)
    setAppMode('gallery')
  }

  const openAgent = () => {
    setAppMode('agent')
  }

  const startNewConversation = () => {
    setAppMode('agent')
    createConversation()
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-72 flex-col border-r border-white/[0.08] bg-[#050505] text-white shadow-[20px_0_80px_rgba(0,0,0,0.45)] lg:flex">
      <div className="safe-area-top flex h-full min-h-0 flex-col px-3 pb-4">
        <div className="flex h-16 shrink-0 items-center gap-3 px-2">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl bg-[#070b1d] shadow-[0_0_30px_rgba(36,226,255,0.32)] ring-1 ring-cyan-300/20" aria-label="绘想空间标志">
            <BrandMarkIcon className="h-10 w-10" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-black tracking-[-0.03em]">绘想空间</div>
            <div className="truncate text-[11px] font-medium text-white/40">Imagination Space</div>
          </div>
        </div>

        <div className="space-y-1.5 border-b border-white/[0.08] pb-3">
          <SidebarNavItem
            active={appMode === 'gallery'}
            icon={<PhotoIcon className="h-5 w-5" />}
            title="画廊"
            subtitle="图片历史与收藏"
            onClick={openGallery}
          />
          <SidebarNavItem
            active={appMode === 'agent'}
            icon={<HistoryIcon className="h-5 w-5" />}
            title="Agent"
            subtitle="对话式生图"
            onClick={openAgent}
          />
          <button
            type="button"
            onClick={startNewConversation}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-2xl bg-white/[0.08] px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/[0.14]"
          >
            <EditIcon className="h-4 w-4" />
            新对话
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/32">历史对话</span>
            <span className="text-[11px] text-white/25">{sortedConversations.length}</span>
          </div>
          <div className="space-y-1">
            {sortedConversations.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] px-3 py-4 text-sm text-white/35">暂无 Agent 对话</div>
            ) : sortedConversations.map((conversation) => {
              const active = appMode === 'agent' && conversation.id === activeConversationId
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => {
                    setAppMode('agent')
                    setActiveConversationId(conversation.id)
                  }}
                  className={`w-full rounded-2xl px-3 py-2.5 text-left transition-colors ${active ? 'bg-white/[0.12] text-white' : 'text-white/62 hover:bg-white/[0.07] hover:text-white'}`}
                >
                  <div className="truncate text-sm font-medium tracking-tight">{getConversationTitle(conversation)}</div>
                  <div className="mt-0.5 truncate text-[11px] text-white/30">{formatSidebarTime(conversation.updatedAt)}</div>
                </button>
              )
            })}
          </div>

          <div className="mb-2 mt-5 flex items-center justify-between px-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/32">最近图片</span>
            <span className="text-[11px] text-white/25">{recentTasks.length}</span>
          </div>
          <div className="space-y-1">
            {recentTasks.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] px-3 py-4 text-sm text-white/35">暂无图片任务</div>
            ) : recentTasks.map((task) => (
              <div
                key={task.id}
                className="group relative rounded-2xl text-white/58 transition-colors hover:bg-white/[0.07] hover:text-white"
              >
                <button
                  type="button"
                  onClick={() => {
                    openGallery()
                    setDetailTaskId(task.id)
                  }}
                  className="w-full rounded-2xl px-3 py-2.5 pr-10 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${task.status === 'done' ? 'bg-emerald-400' : task.status === 'running' ? 'bg-blue-400' : 'bg-red-400'}`} />
                    <span className="min-w-0 truncate text-sm font-medium tracking-tight">{getTaskTitle(task)}</span>
                  </div>
                  <div className="mt-0.5 truncate pl-3.5 text-[11px] text-white/28">{formatSidebarTime(task.createdAt)}</div>
                </button>
                <button
                  type="button"
                  aria-label="删除最近图片"
                  title="删除最近图片"
                  onClick={(event) => {
                    event.stopPropagation()
                    setConfirmDialog({
                      title: '删除任务',
                      message: '确定要删除这条最近图片记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
                      tone: 'danger',
                      action: () => removeTask(task),
                    })
                  }}
                  className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-white/38 opacity-100 transition hover:bg-red-500/15 hover:text-red-300 focus:outline-none focus:ring-1 focus:ring-red-300/40"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 border-t border-white/[0.08] pt-3">
          <button
            type="button"
            onClick={() => setShowSettings(true, 'api')}
            className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-semibold text-white/68 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.06] text-white/75"><SettingsIcon className="h-5 w-5" /></span>
            配置 API Key
          </button>
        </div>
      </div>
    </aside>
  )
}
