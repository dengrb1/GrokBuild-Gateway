# GrokBuild Gateway (`gbg`)

类似 **CC Switch** 的 **Grok Build 专用** 供应商 / 模型切换工具。

- 多供应商档案（Okinto / CCX / xAI / Anthropic / OpenAI Responses / 自定义）
- **模型映射**：Grok 发出的模型名 → 上游真实模型名（可按映射钉死供应商）
- **本地网关**：Grok 固定指向 `http://127.0.0.1:8787/v1`，切换供应商 **无需重启 Grok**
- **三协议**：`chat_completions` / `responses` / `messages` 互转（含 Tools / SSE）
- **双产物**：`gbg.exe`（纯网关 + WebUI）+ `gbg-desktop.exe`（托盘客户端）
- **代理盾**：强制用 `127.0.0.1`，防止系统代理把本机网关搞挂
- **主题**：浅色 / 深色 / 跟随系统

## 原理

Grok Build 从 `~/.grok/config.toml` 读取 `base_url`，**不会热重载**。  
因此把 Grok 一次性指到本机网关；网关在内存里热切换上游与映射。

```
Grok Build  ──►  gbg :8787  ──►  active provider (Okinto / CCX / …)
                 │
                 ├─ model map
                 ├─ inject API key
                 └─ hot reload config
```

## 两个发布产物

| 文件 | 用途 |
|------|------|
| `release/gbg.exe` | 纯网关 + 内嵌 WebUI（CLI / 无托盘） |
| `release/gbg-desktop.exe` | **单文件客户端**：内置网关 + 托盘 + 启停 + 开机自启（无需旁挂 gbg.exe） |

### 打包

```bash
# 仅网关（CLI）
npm run build:exe

# 桌面客户端（会先编 gbg.exe 再嵌入）
npm run build:desktop

# 两者
npm run build:all
```

### 运行

**纯 WebUI / CLI：**

```bash
.\release\gbg.exe serve
# 浏览器打开 http://127.0.0.1:8787/
```

**桌面客户端（内置网关，单文件即可）：**

```bash
.\release\gbg-desktop.exe
```

- 首次运行将内置 `gbg` 解压到 `%LOCALAPPDATA%\GrokBuild-Gateway\runtime\` 并 **自动启动网关**
- 启动页可手动 **启动 / 停止**；托盘同样可操作
- 关窗口默认藏到托盘（不杀网关）；托盘「退出」会停网关
- **开机自启**：启动页开关
- 依赖系统 **WebView2**（Win10/11 通常已装）
- 可选：`--no-gateway` 只开壳不启网关；`GBG_PORT` 改端口

开发模式：

```bash
npm run dev                 # 网关
npm run dev:desktop         # 桌面壳（需本机已有 gbg / 或先 build:exe）
```

## 防系统代理搞挂网关（重要）

系统 HTTP(S) 代理有时会劫持访问 `localhost` / 本机端口，导致 Grok 或浏览器「连不上网关」。

本项目采取：

1. **全链路只用 `http://127.0.0.1:<port>`**，不用 `localhost`（避免 `::1` / 代理例外差异）
2. 网关进程启动时写入 `NO_PROXY` 含 `127.0.0.1,localhost,::1`
3. 默认 `server.proxyMode = "direct"`：出站访问上游时 **忽略** 环境代理（坏代理不会连带拖死上游）；需要公司代理出网时改为 `"env"`
4. 桌面端启动 `gbg.exe` 时注入同样的 `NO_PROXY` 并剥离子进程代理变量
5. `gbg doctor` 检查代理风险；可选 `gbg doctor --fix-proxy` 把 loopback 合并进 **用户级** `NO_PROXY`（不改 WinINET 全局代理）

Windows 系统设置里也建议勾选 **「请勿将代理服务器用于本地 (Intranet) 地址」**，或在代理例外中加入 `127.0.0.1`。

## 快速开始

### 要求

- Node.js ≥ 20（开发 / 测试）
- [Bun](https://bun.sh)（打包 `gbg.exe`）
- Rust / cargo（打包 `gbg-desktop.exe`）

### 安装与开发

```bash
cd GrokBuild-Gateway
npm install
npm test
npm run gbg -- serve
```

### 让 Grok 走网关（只需一次）

**推荐：一键写入**（自动备份 `~/.grok/config.toml`，地址为 `127.0.0.1`）

```bash
gbg apply-grok --yes
# 或 Web UI → 总览 →「一键写入 Grok 配置」
```

写入后 **重启一次 Grok**。之后切换供应商无需再重启。

API Key 环境变量示例：

```powershell
[System.Environment]::SetEnvironmentVariable("OKINTO_API_KEY", "sk-...", "User")
[System.Environment]::SetEnvironmentVariable("CCX_API_KEY", "sk-...", "User")
```

### 切换供应商（免重启 Grok）

```bash
gbg provider list
gbg provider use ccx
gbg provider test okinto
```

或在 Web UI → 供应商 → **使用**。

### 模型映射 / 虚拟模型

```bash
gbg map set grok-4.5 claude-opus-4 --provider ccx
gbg fetch-models okinto
gbg import-models okinto --target both --mode merge
```

## CLI

| 命令 | 说明 |
|------|------|
| `gbg serve` | 启动网关 + Web UI |
| `gbg status` | 状态 |
| `gbg provider …` | 供应商 |
| `gbg map …` | 映射 |
| `gbg models` / `fetch-models` / `import-models` | 模型 |
| `gbg bootstrap` | 打印 Grok 配置片段 |
| `gbg apply-grok [--yes]` | 一键写入 Grok 配置 |
| `gbg doctor [--fix-proxy]` | 环境自检（含代理盾） |

## 配置

默认：`%USERPROFILE%\.gbg\config.json`（`GBG_HOME` 可覆盖）。

关键字段：

- `activeProviderId` / `providers[]` / `modelMaps[]` / `virtualModels[]`
- `server.host` / `server.port`（默认 `127.0.0.1:8787`）
- `server.proxyShield`：全局代理防护开关（默认 `true`；UI 可切换）
- `server.proxyMode`：`direct` / `env`（与 `proxyShield` 同步，兼容旧配置）
- `providers[].proxyShield`：单供应商代理防护（默认 `true`；仅全局开启时生效）
- `server.gatewayToken`：可选访问令牌

## Web UI

- 总览 / 供应商 / 映射 / 虚拟模型 / 请求日志
- 主题：浅色 · 深色 · 跟随系统（`localStorage`）
- 顶栏 **代理盾** 状态徽章
- **总览**：全局代理防护开关
- **供应商**：列表与编辑表单均可单独开关代理防护

## Control API（摘要）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/health` | 健康 + `proxyShield` + `publicBase` |
| GET | `/api/snapshot` | UI 轮询（可 204） |
| POST | `/api/active-provider` | 热切换 |
| POST | `/api/apply-grok` | 一键写 Grok 配置 |

OpenAI / Anthropic 兼容：`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。

## 安全说明

- 默认只绑定 `127.0.0.1`
- 密钥脱敏；推荐 `apiKey: "env:VAR"`
- 不默认修改系统全局代理设置

## License

MIT
