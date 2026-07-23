# AGENTS.md

本仓库是 GrokBuild Gateway。后续修改请遵守下面约定。

## 当前产品约定

- 新增供应商默认协议是 `responses`。
- Anthropic 供应商继续使用 `messages`，不要改成 `responses`。
- 旧配置中已经显式保存的 `apiBackend` 不自动迁移，避免覆盖用户配置。
- 模型映射里的目标模型 ID 快捷填入只来自上游 `/models` 拉取结果，不维护硬编码常用模型列表。
- Chat tools 转 OpenAI Responses 时，`function_call.call_id` 必须保留原始 Chat tool call id，`function_call.id` 使用 `fc_` 前缀的 Responses item id，`function_call_output.call_id` 与原始 id 对齐。
- 转换工具定义时保留 OpenAI 兼容字段，例如 `strict`。

## 构建产物

- `release/gbg.exe`：纯网关 + 内嵌 WebUI。
- `release/gbg-desktop.exe`：标准桌面版，Tauri / WebView2。
- `release/gbg-desktop-compat.exe`：兼容桌面版，无 WebView2，使用系统浏览器打开 WebUI。

构建命令：

```bash
npm run build:exe
npm run build:desktop
npm run build:desktop:compat
npm run build:all
```

如果 Windows 报目标 exe 被占用，先停止正在运行的旧进程，再重新构建。

## 验证

协议或网关转换相关改动至少跑：

```bash
npm test -- --run tests/protocol.test.ts tests/proxy-protocol.test.ts
npm run typecheck
```

发布前跑：

```bash
npm test
npm run build:desktop
npm run build:desktop:compat
```
