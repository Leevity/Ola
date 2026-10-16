# 桌面组件状态审查页 QA

**Findings**

- 已修复：危险操作按钮与标签使用固定白字和深色半透明背景，协同工作区深色文字对比度约 4.49:1。改为产品主题已有的 destructive foreground 和实色背景，实测为 #20212C / #FF9B9B，约 7.92:1。3 项渲染与颜色回归检查通过。
- 审查页沿用实际 connected 主题 CSS 变量；只导入 CSS 而不应用运行时主题会落到旧的黑色默认按钮，现已通过实际主题定义修正。

**Open Questions**

- 此结论仅覆盖本地桌面组件审查页。Mac 安装包启动、实际桌面完整页面、Android / iOS / Web 的组件状态不由此页证明。

**Implementation Checklist**

- 实际 Button / Input / Badge / Alert / Skeleton / Spinner / Switch / OlaBrand，无 IPC 或网络 API。
- 中文浅色、中文深色和英文 390px 容器已呈现；390px 容器实测 scrollWidth=390，不是手机真机视口验收。
- 错误输入通过 aria-invalid 和 aria-describedby 关联文字；加载状态有可访问名称；保存反馈有 status。
- 键盘 Tab 焦点可见；可滚动目录键盘 End 到末尾 scrollTop=389，clientHeight=198，scrollHeight=587；第 12 项及外部操作按钮可见。
- 减少动画样式覆盖审查页；禁用控件明确不可操作。
- TypeScript、审查页生产构建、定向 ESLint 通过。

**Follow-up Polish**

- 其余三种渲染实现继续使用各自实际组件做状态审查，不能把此页截图作为原生移动端截图。

source visual truth path: ../../../Ola-brand-unification-2026-10-16/concepts/02-connected-workspace.png
implementation screenshot path: ../../../Ola-brand-unification-2026-10-16/verification/brand-second-batch/components-desktop-light.png
viewport: 浏览器约 1269×714；额外检查 390px 内容容器
state: 中文浅色、中文深色、英文窄容器、键盘焦点、错误、加载、禁用、空目录、列表末项
full-view comparison evidence: components-desktop-light.png / components-desktop-dark.png；使用选定方向的蓝紫语义色、ola 字标及浅层边框；这是组件审查工具，不复刻整页信息架构
focused region comparison evidence: components-desktop-dark-list-end.png / components-desktop-en-390-focus.png；DOM 颜色和滚动数据作为补充
patches made since previous QA: Tailwind 源扫描、实际主题接入、危险操作前景色、窄容器重排
final result: passed
