import { ComplianceGate as ReusableComplianceGate, spaceComplianceGateConfig } from '../modules/complianceGate'

export default function ComplianceGate() {
  return <ReusableComplianceGate config={spaceComplianceGateConfig} />
}
