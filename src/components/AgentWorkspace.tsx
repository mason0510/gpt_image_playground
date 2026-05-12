import { useEffect, useMemo, useState, useRef } from 'react'
import type { AgentRound, TaskRecord } from '../types'
import { editOutputs, ensureImageThumbnailCached, ensureImageCached, removeMultipleTasks, removeTask, reuseConfig, useStore } from '../store'
import TaskCard from './TaskCard'
import { useDragSelect } from '../hooks/useDragSelect'

function ReferenceThumb({ 
  imageId, 
  imageIds, 
  isSelected, 
  onToggleSelect, 
  isMultiSelecting, 
  onLongPress,
  selectedIds
}: { 
  imageId: string; 
  imageIds: string[];
  isSelected: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  isMultiSelecting: boolean;
  onLongPress: () => void;
  selectedIds: string[];
}) {
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const addInputImage = useStore((s) => s.addInputImage)
  const showToast = useStore((s) => s.showToast)
  const [src, setSrc] = useState('')
  const pressTimer = useRef<number | null>(null)
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  useEffect(() => {
    let cancelled = false
    ensureImageThumbnailCached(imageId)
      .then((thumbnail) => {
        if (!cancelled) setSrc(thumbnail?.dataUrl ?? '')
      })
      .catch(() => {
        if (!cancelled) setSrc('')
      })
    return () => {
      cancelled = true
    }
  }, [imageId])

  const addToInput = async () => {
    const dataUrl = await ensureImageCached(imageId)
    if (!dataUrl) {
      showToast('图片已不存在', 'error')
      return
    }
    addInputImage({ id: imageId, dataUrl })
    showToast('已添加到本轮参考图', 'success')
  }

  const handleTouchStart = () => {
    pressTimer.current = window.setTimeout(() => {
      onLongPress()
    }, 500)
  }

  const handleTouchEnd = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    if (isMultiSelecting) {
      onToggleSelect(e)
      return
    }
    const isCtrl = isMac ? e.metaKey : e.ctrlKey
    if (isCtrl) {
      onToggleSelect(e)
      return
    }
    setLightboxImageId(imageId, imageIds)
  }

  return (
    <div className="reference-thumb-wrapper" data-image-id={imageId}>
      <button
        type="button"
        className={`relative h-20 w-20 overflow-hidden rounded-lg border bg-gray-100 dark:bg-white/[0.04] transition-all ${
          isSelected 
            ? 'border-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.5)]' 
            : 'border-gray-200 dark:border-white/[0.08]'
        }`}
        onClick={handleClick}
        onDoubleClick={addToInput}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchEnd}
        draggable
        onDragStart={(event) => {
          if (isSelected && selectedIds.length > 1) {
            event.dataTransfer.setData('text/plain', `agent-images:${selectedIds.join(',')}`)
          } else {
            event.dataTransfer.setData('text/plain', `agent-image:${imageId}`)
          }
          event.dataTransfer.effectAllowed = 'copy'
        }}
        title="双击添加到当前输入，或拖到输入区"
      >
        {src ? <img src={src} className="h-full w-full object-cover" alt="" /> : <span className="text-xs text-gray-400">图片</span>}
        {isSelected && (
          <div className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-white">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </button>
    </div>
  )
}

function formatTime(value: number) {
  return new Date(value).toLocaleString()
}

function getRoundTasks(round: AgentRound | null, tasks: TaskRecord[]) {
  if (!round) return []
  return round.outputTaskIds.map((taskId) => tasks.find((task) => task.id === taskId) ?? null)
}

export default function AgentWorkspace() {
  const conversations = useStore((s) => s.agentConversations)
  const activeConversationId = useStore((s) => s.activeAgentConversationId)
  const createConversation = useStore((s) => s.createAgentConversation)
  const setActiveConversationId = useStore((s) => s.setActiveAgentConversationId)
  const renameConversation = useStore((s) => s.renameAgentConversation)
  const deleteConversation = useStore((s) => s.deleteAgentConversation)
  const sidebarCollapsed = useStore((s) => s.agentSidebarCollapsed)
  const setSidebarCollapsed = useStore((s) => s.setAgentSidebarCollapsed)
  const assetTab = useStore((s) => s.agentAssetTab)
  const setAssetTab = useStore((s) => s.setAgentAssetTab)
  const assetPanelCollapsed = useStore((s) => s.agentAssetPanelCollapsed)
  const setAssetPanelCollapsed = useStore((s) => s.setAgentAssetPanelCollapsed)
  const tasks = useStore((s) => s.tasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setPrompt = useStore((s) => s.setPrompt)
  const setAppMode = useStore((s) => s.setAppMode)

  const conversation = conversations.find((item) => item.id === activeConversationId) ?? null
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null)
  const selectedRound = conversation?.rounds.find((round) => round.id === selectedRoundId) ?? conversation?.rounds[conversation.rounds.length - 1] ?? null
  const roundTasks = getRoundTasks(selectedRound, tasks)
  const referenceImageIds = selectedRound?.inputImageIds ?? []

  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([])
  const [isMobileMultiSelecting, setIsMobileMultiSelecting] = useState(false)

  const { selectionBox } = useDragSelect({
    containerSelector: '[data-reference-grid-root]',
    itemSelector: '.reference-thumb-wrapper',
    getItemId: (el) => el.getAttribute('data-image-id'),
    onSelectionChange: setSelectedReferenceIds,
    initialSelectedIds: selectedReferenceIds,
  })

  useEffect(() => {
    setSelectedReferenceIds([])
    setIsMobileMultiSelecting(false)
  }, [assetTab, selectedRoundId])

  const toggleReferenceSelect = (id: string, force?: boolean) => {
    setSelectedReferenceIds((prev) => {
      const isSelected = prev.includes(id)
      const shouldSelect = force !== undefined ? force : !isSelected
      if (shouldSelect === isSelected) return prev
      return shouldSelect ? [...prev, id] : prev.filter((x) => x !== id)
    })
  }

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  )

  const handleDeleteConversation = (id: string) => {
    setConfirmDialog({
      title: '删除对话',
      message: '确定要删除这个 Agent 对话吗？已同步到画廊的任务记录不会自动删除。',
      action: () => deleteConversation(id),
    })
  }

  const handleRenameConversation = (id: string, currentTitle: string) => {
    const title = window.prompt('输入新的对话标题', currentTitle)
    if (title != null) renameConversation(id, title)
  }

  const handleDeleteRound = (round: AgentRound) => {
    setConfirmDialog({
      title: '删除轮次',
      message: '确定要删除这一轮消息吗？关联的生成任务也会按画廊逻辑删除。',
      action: async () => {
        if (round.outputTaskIds.length > 0) await removeMultipleTasks(round.outputTaskIds)
        useStore.setState((state) => ({
          agentConversations: state.agentConversations.map((item) =>
            item.id === conversation?.id
              ? {
                  ...item,
                  updatedAt: Date.now(),
                  rounds: item.rounds.filter((candidate) => candidate.id !== round.id),
                  messages: item.messages.filter((message) => message.roundId !== round.id),
                }
              : item,
          ),
        }))
      },
    })
  }

  const handleReuse = (task: TaskRecord) => {
    setConfirmDialog({
      title: '切换到画廊模式？',
      message: '复用参数会应用到画廊输入区。切换到画廊模式后，当前 Agent 对话仍会保留。',
      confirmText: '切换并复用',
      cancelText: '取消',
      action: () => {
        setAppMode('gallery')
        void reuseConfig(task)
      },
    })
  }

  return (
    <main data-agent-workspace className="safe-area-x mx-auto flex flex-col lg:flex-row max-w-7xl gap-3 pb-48">
      {!sidebarCollapsed && (
        <aside className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-white/[0.08] pb-3 lg:pb-0 lg:pr-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" onClick={() => setSidebarCollapsed(true)} className="text-sm text-gray-500">折叠</button>
            <button type="button" onClick={createConversation} className="text-sm text-blue-500">新对话</button>
          </div>
          <div className="space-y-1">
            {sortedConversations.map((item) => (
              <div key={item.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-gray-100 dark:hover:bg-white/[0.04]">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setActiveConversationId(item.id)}>
                  <div className={item.id === activeConversationId ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}>{item.title}</div>
                  <div className="text-xs text-gray-400">{formatTime(item.updatedAt)}</div>
                </button>
                <button type="button" className="opacity-0 group-hover:opacity-100 text-xs" onClick={() => handleRenameConversation(item.id, item.title)}>编辑</button>
                <button type="button" className="opacity-0 group-hover:opacity-100 text-xs text-red-500" onClick={() => handleDeleteConversation(item.id)}>删除</button>
              </div>
            ))}
          </div>
        </aside>
      )}

      {sidebarCollapsed && (
        <button type="button" onClick={() => setSidebarCollapsed(false)} className="self-start rounded-lg border px-3 py-2 text-sm text-gray-500">展开对话</button>
      )}

      <section className="min-w-0 flex-1 space-y-4">
        {!conversation ? (
          <div className="py-20 text-center text-gray-400">
            <p className="mb-3">还没有 Agent 对话</p>
            <button type="button" onClick={createConversation} className="rounded-lg bg-blue-500 px-4 py-2 text-white">创建对话</button>
          </div>
        ) : (
          conversation.messages.map((message) => {
            const round = conversation.rounds.find((item) => item.id === message.roundId)
            return (
              <article key={message.id} className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white/70 p-4 dark:bg-white/[0.03]">
                <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
                  <button type="button" onClick={() => setSelectedRoundId(message.roundId)}>
                    第 {round?.index ?? '?'} 轮 · {message.role === 'user' ? '用户' : 'Agent'}
                  </button>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => navigator.clipboard?.writeText(message.content)}>复制</button>
                    {message.role === 'user' && <button type="button" onClick={() => setPrompt(message.content)}>编辑</button>}
                    {round && <button type="button" className="text-red-500" onClick={() => handleDeleteRound(round)}>删除</button>}
                  </div>
                </div>
                <div className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100">{message.content}</div>
                {message.role === 'assistant' && round?.outputTaskIds.some((taskId) => !tasks.some((task) => task.id === taskId)) && (
                  <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-3 text-xs text-gray-400 dark:border-white/[0.12]">
                    [generated image removed]
                  </div>
                )}
              </article>
            )
          })
        )}
      </section>

      {!assetPanelCollapsed && (
        <aside className="w-full lg:w-80 shrink-0 lg:border-l border-t lg:border-t-0 border-gray-200 lg:pl-3 pt-3 lg:pt-0 dark:border-white/[0.08]">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex rounded-lg border border-gray-200 p-1 text-sm dark:border-white/[0.08]">
              <button type="button" onClick={() => setAssetTab('references')} className={assetTab === 'references' ? 'px-3 py-1 font-semibold' : 'px-3 py-1 text-gray-500'}>参考</button>
              <button type="button" onClick={() => setAssetTab('outputs')} className={assetTab === 'outputs' ? 'px-3 py-1 font-semibold' : 'px-3 py-1 text-gray-500'}>输出</button>
            </div>
            <button type="button" onClick={() => setAssetPanelCollapsed(true)} className="text-sm text-gray-500">折叠</button>
          </div>
          {assetTab === 'references' ? (
            <div data-reference-grid-root className="relative">
              <div className="grid grid-cols-3 gap-2">
                {referenceImageIds.map((imageId) => (
                  <ReferenceThumb 
                    key={imageId} 
                    imageId={imageId} 
                    imageIds={referenceImageIds} 
                    isSelected={selectedReferenceIds.includes(imageId)}
                    onToggleSelect={(e) => toggleReferenceSelect(imageId)}
                    isMultiSelecting={isMobileMultiSelecting || selectedReferenceIds.length > 0}
                    onLongPress={() => {
                      setIsMobileMultiSelecting(true)
                      toggleReferenceSelect(imageId, true)
                    }}
                    selectedIds={selectedReferenceIds}
                  />
                ))}
                {referenceImageIds.length === 0 && <p className="col-span-3 text-sm text-gray-400">本轮没有参考图</p>}
              </div>
              {selectionBox && (
                <div
                  className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
                  style={{
                    left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
                    top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
                    width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
                    height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
                  }}
                />
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {roundTasks.map((task, index) => task ? (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => setDetailTaskId(task.id)}
                  onReuse={() => handleReuse(task)}
                  onEditOutputs={() => editOutputs(task)}
                  onDelete={() => setConfirmDialog({ title: '删除记录', message: '确定要删除这条记录吗？', action: () => removeTask(task) })}
                />
              ) : (
                <div key={index} className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-white/[0.12]">[generated image removed]</div>
              ))}
              {roundTasks.length === 0 && <p className="text-sm text-gray-400">本轮没有输出图</p>}
            </div>
          )}
        </aside>
      )}

      {assetPanelCollapsed && (
        <button type="button" onClick={() => setAssetPanelCollapsed(false)} className="self-start rounded-lg border px-3 py-2 text-sm text-gray-500">展开图片</button>
      )}
    </main>
  )
}
