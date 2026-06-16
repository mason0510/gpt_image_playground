import type { ReactNode } from 'react'

export type ComplianceGateLink = {
  label: string
  href: string
}

export type ComplianceGateStorage = {
  isConfirmed: () => boolean
  confirm: () => void
}

export type ComplianceGateConfig = {
  storageKey: string
  badgeLabel: ReactNode
  title: ReactNode
  description?: ReactNode
  noticeTitle: ReactNode
  policyItems: ReactNode[]
  links: ComplianceGateLink[]
  checkboxLabel: ReactNode
  confirmButtonLabel: ReactNode
}

export type ComplianceGateProps = {
  config: ComplianceGateConfig
  storage?: ComplianceGateStorage
  className?: string
}
