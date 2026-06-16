import type { ComplianceGateConfig } from './types'

export const spaceComplianceGateConfig: ComplianceGateConfig = {
  storageKey: 'imagination-space-compliance-confirmed-v1',
  badgeLabel: '使用前确认 / Required confirmation',
  title: '请先确认合规使用',
  description: (
    <p>
      禁止使用本服务生成、传播或协助任何黄赌毒、违法、暴力极端、军事武器、欺诈、侵权，或其他违反适用国家法律法规和平台规则的内容。
    </p>
  ),
  noticeTitle: 'Before creating or managing API keys, please confirm that you will not use this service from a restricted region or for prohibited, abusive, or unlawful activity.',
  policyItems: [
    'The service is not offered to users located in restricted regions, including mainland China.',
    'You must not evade regional, payment, provider, or legal restrictions.',
    'You must comply with the Terms, Privacy Policy, Acceptable Use Policy, Refund and Suspension Policy, and Restricted Regions Notice.',
  ],
  links: [
    { label: 'Terms', href: 'https://zz1cc.cc.cd/legal/terms' },
    { label: 'Privacy', href: 'https://zz1cc.cc.cd/legal/privacy' },
    { label: 'Acceptable Use', href: 'https://zz1cc.cc.cd/legal/acceptable-use' },
    { label: 'Refund', href: 'https://zz1cc.cc.cd/legal/refund-suspension' },
    { label: 'Restricted Regions', href: 'https://zz1cc.cc.cd/legal/restricted-regions' },
  ],
  checkboxLabel: 'I confirm that I am eligible to continue and will not use this service from a restricted region or for prohibited activity.',
  confirmButtonLabel: '确认并进入 / Confirm and continue',
}
