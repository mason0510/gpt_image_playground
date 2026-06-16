import { useEffect, useMemo, useState } from 'react'
import { createComplianceStorage } from './storage'
import type { ComplianceGateProps } from './types'
import { useComplianceScrollLock } from './useComplianceScrollLock'

export function ComplianceGate({ config, storage, className }: ComplianceGateProps) {
  const resolvedStorage = useMemo(() => storage ?? createComplianceStorage(config.storageKey), [config.storageKey, storage])
  const [confirmed, setConfirmed] = useState(() => resolvedStorage.isConfirmed())
  const [checked, setChecked] = useState(false)

  useComplianceScrollLock(!confirmed)

  useEffect(() => {
    setConfirmed(resolvedStorage.isConfirmed())
  }, [resolvedStorage])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === config.storageKey) setConfirmed(resolvedStorage.isConfirmed())
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [config.storageKey, resolvedStorage])

  if (confirmed) return null

  const handleConfirm = () => {
    if (!checked) return
    resolvedStorage.confirm()
    setConfirmed(true)
  }

  return (
    <div data-no-drag-select className={`fixed inset-0 z-[200] flex items-center justify-center bg-[#050510]/95 p-4 text-white backdrop-blur-xl ${className ?? ''}`}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(59,130,246,0.28),transparent_32%),radial-gradient(circle_at_80%_18%,rgba(168,85,247,0.26),transparent_30%),radial-gradient(circle_at_50%_100%,rgba(245,158,11,0.14),transparent_36%)]" />
      <section className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[2rem] border border-white/15 bg-white/[0.08] p-6 shadow-2xl shadow-black/40 ring-1 ring-white/10 backdrop-blur-2xl sm:p-8">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1.5 text-xs font-bold text-amber-100">
          <span className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_18px_rgba(252,211,77,0.9)]" />
          {config.badgeLabel}
        </div>

        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">{config.title}</h1>
        {config.description ? <div className="mt-3 text-sm leading-7 text-slate-300">{config.description}</div> : null}

        <div className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-4 text-sm leading-7 text-slate-200">
          <p className="font-semibold text-white">{config.noticeTitle}</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-300">
            {config.policyItems.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {config.links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:border-cyan-200/50 hover:bg-cyan-300/15"
            >
              {link.label}
            </a>
          ))}
        </div>

        <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.06] p-4 text-sm leading-6 text-slate-200 transition hover:bg-white/[0.09]">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-white/20 bg-black/30 text-blue-500 focus:ring-blue-400"
          />
          <span>{config.checkboxLabel}</span>
        </label>

        <button
          type="button"
          disabled={!checked}
          onClick={handleConfirm}
          className="mt-6 w-full rounded-2xl bg-gradient-to-r from-blue-500 via-violet-500 to-amber-400 px-5 py-3 text-sm font-black text-white shadow-lg shadow-blue-950/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:brightness-100"
        >
          {config.confirmButtonLabel}
        </button>
      </section>
    </div>
  )
}
