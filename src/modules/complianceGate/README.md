# ComplianceGate 可复用模块

这个目录是可直接搬到其他 React + Tailwind 项目的合规确认门禁模块。

## 组成

- `ComplianceGate.tsx`：通用弹窗组件，只依赖传入的 `config`。
- `types.ts`：配置与存储接口类型。
- `storage.ts`：默认确认状态存储，优先 `localStorage`，同时写 cookie 作为 fallback。
- `useComplianceScrollLock.ts`：弹窗打开时锁定背景滚动，模块内自带，不依赖项目 hooks。
- `presets.tsx`：当前 `space.tap365.org` 的业务文案配置。
- `index.ts`：统一导出入口。

## 最小接入

```tsx
import { ComplianceGate, type ComplianceGateConfig } from './modules/complianceGate'

const config: ComplianceGateConfig = {
  storageKey: 'your-product-compliance-confirmed-v1',
  badgeLabel: '使用前确认 / Required confirmation',
  title: '请先确认合规使用',
  description: <p>你的项目合规说明。</p>,
  noticeTitle: 'Please confirm that you are eligible to continue.',
  policyItems: ['Do not use this service for prohibited activity.'],
  links: [{ label: 'Terms', href: 'https://example.com/terms' }],
  checkboxLabel: 'I confirm that I am eligible to continue.',
  confirmButtonLabel: '确认并进入 / Confirm and continue',
}

export function App() {
  return <ComplianceGate config={config} />
}
```

## 当前项目接入方式

当前项目保留了薄封装：

```tsx
// src/components/ComplianceGate.tsx
import { ComplianceGate, spaceComplianceGateConfig } from '../modules/complianceGate'

export default function AppComplianceGate() {
  return <ComplianceGate config={spaceComplianceGateConfig} />
}
```

以后其他项目只需要复制 `src/modules/complianceGate`，再新建自己的 `presets.tsx` 或直接传入 `config`。
