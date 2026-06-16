import type { ComplianceGateConfig } from './types'

export const spaceComplianceGateConfig: ComplianceGateConfig = {
  storageKey: 'imagination-space-compliance-confirmed-v1',
  badgeLabel: '合规确认 / Compliance confirmation',
  title: '请先确认合规使用',
  description: (
    <div className="space-y-3">
      <p>在创建或管理 API Key 之前，请先确认你不会从受限制地区使用本服务，也不会将本服务用于被禁止、滥用或违法的用途。</p>
      <p>Before creating or managing API keys, please confirm that you will not use this service from a restricted region or for prohibited, abusive, or unlawful activity.</p>
    </div>
  ),
  noticeTitle: '合规确认 / Compliance Confirmation',
  policyItems: [
    '本服务不向以下受限制地区用户提供，包括：中国大陆、香港、澳门。 / This service is not offered to users located in restricted regions, including mainland China, Hong Kong, and Macau.',
    '不得规避地区限制、支付限制、服务商限制或法律限制。 / You must not evade regional, payment, provider, or legal restrictions.',
    '不得将本服务用于黄赌毒、军事、诈骗、侵权、滥用或其他违法违规用途。 / You must not use this service for pornography, gambling, drugs, military-related activity, fraud, infringement, abuse, or any other unlawful or prohibited purpose.',
    '使用本服务即表示你确认自己具备继续使用的资格，并愿意自行承担不合规使用带来的责任。 / By using this service, you confirm that you are eligible to continue and accept responsibility for any non-compliant use.',
  ],
  links: [],
  checkboxLabel:
    '本人确认：我不位于受限制地区，且不会将本服务用于任何被禁止、滥用或违法的活动。 / I confirm that I am not located in a restricted region and will not use this service for any prohibited, abusive, or unlawful activity.',
  confirmButtonLabel: '确认并进入 / Confirm and continue',
}
