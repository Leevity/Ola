# Ola 文档站点

这是 Ola 的独立文档站点，基于 **Fumadocs + Next.js** 构建。

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## 类型检查

```bash
npm run types:check
```

## 内容位置

- 文档内容：`docs/docs/`
- 静态资源：`docs/public/`
- MDX 组件：`docs/src/mdx-components.tsx`
- 文档源配置：`docs/source.config.ts`

## 运行机制

`npm run dev` 和 `npm run build` 都会先执行 `scripts/generate-skills-index.mjs`，再启动 Next.js。

如果你要更新文档内容，优先修改 `docs/docs/` 下的 MDX 文件。