# Ola 协同工作区设计基础

`tokens.json`是共享颜色、间距、圆角、动效与字体尺度的唯一来源。版本采用语义化版本号；变更后运行：

```sh
node scripts/sync-ola-design.mjs
node scripts/sync-ola-design.mjs --check
```

脚本从Ola仓库定位同级Ola-admin和ola-mobile，生成Web CSS/TypeScript、Android Kotlin、iOS Swift与AccentColor资源。生成文件禁止手工修改。`generated/manifest.json`记录来源与各输出SHA-256；check同时验证深浅色关键文字组合至少4.5:1对比度。

桌面新安装默认跟随系统并使用connected主题；保留原有主题预设与已保存选择。原生客户端继续使用各自平台的导航与辅助功能能力。

`assets/ola-icon.png`由内置Image Gen基于用户选定的协同工作区稿生成，保留小写ola字符。平台导出已覆盖应用内 PNG、桌面 PNG/ICO、Android 启动图标及 iOS 1024px/备用图标。macOS 托盘使用含 ola 字符的透明单色模板，提供 1x/2x 分辨率；商店上架验收仍待完成。

产品接入与真实交互验收分阶段执行，设计变量检查通过不代表跨端业务闭环通过。

## 品牌资源导出

在 macOS 上运行 `node scripts/export-ola-brand.mjs`，通过系统 sips 将选定原图导出为平台尺寸并封装 Windows 多尺寸 ICO。只做尺寸和文件格式转换，不重新生成图案。输出清单及 SHA-256 保存在 `generated/brand-assets.json`。

`node scripts/export-ola-brand.mjs --check` 可在任意平台核对同级三个仓库的导出文件。Android 自适应图标引用统一 drawable，单色图层保留 ola 字符。iOS 图标文件更新不代表已运行或已签名验收。

托盘模板由 `scripts/export-ola-mono-icon.swift` 使用系统 CoreGraphics 绘制，与 Android 单色图层沿用同一 ola 轮廓。导出清单同时记录绘制源码哈希。托盘实际呈现仍需本机解锁后核对。
