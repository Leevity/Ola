# Ola 桌面组件状态审查

运行 `npx vite --config tools/design-review/vite.config.ts`，访问终端给出的本地地址。
类型检查 `npx tsc --project tools/design-review/tsconfig.json`。
构建 `npx vite build --config tools/design-review/vite.config.ts`；输出到已忽略的 node_modules/.cache。

此开发工具直接导入产品的 Button、Input、Badge、Alert、Skeleton、Spinner、Switch、Select、Dialog 和 OlaBrand，
沿用真实桌面样式和共享设计变量。它不导入 App、不加载 IPC、不访问账户或设备，不进入 Electron 安装包。
所有操作只改变页面内存。示例状态不能作为真实登录、同步或执行任务的证据。

检查中文/英文、深色/浅色、390/768/1024/1440 宽度和键盘 Tab。
“390px 容器”用于本页组件重排检查，不等于真实手机视口验收。确认长值换行，
列表第 12 项可达，操作在滚动目录之外，错误包含文字与可访问描述。

该页只证明桌面渲染组件。Web 控制台、Android Compose、iOS SwiftUI 需分别建立审查证据。

选择器和确认弹窗用于检查键盘选择、禁用选项、Escape、焦点约束与关闭后焦点返回。
Radix Portal 继承同一套 connected 主题变量；它们不会发出业务请求。
