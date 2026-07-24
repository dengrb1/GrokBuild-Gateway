# GrokBuild Gateway (`gbg`)

**Grok Build 专用** 供应商 / 模型切换工具。

- 多供应商档案（Okinto / CCX / xAI / Anthropic / OpenAI Responses / 自定义）
- **模型映射**：Grok 发出的模型名 → 上游真实模型名（可钉死供应商；支持**多渠道候选链**）
- **故障转移（Failover）**：候选链上 429 / 5xx / 超时 / 网络错误，且**尚未向客户端写出首字节**时自动切换下一渠道
- **本地网关**：Grok 固定指向 `http://127.0.0.1:8787/v1`，切换供应商 **无需重启 Grok**
- **三协议**：`chat_completions` / `responses` / `messages` 互转（新增供应商默认 `responses`，Anthropic 仍为 `messages`）
- **Tools 修复**：Chat tools 转 Responses 时会规范 `function_call.id` / `call_id`，避免上游因 tool call 形状异常断开连接
- **便携配置**：配置写在**运行目录**下的 `data/`，不默认散落在用户主目录
- **还原配置**：一键恢复出厂默认，或从 `data/backups/` 还原；操作前自动备份当前配置
- **三产物**：`gbg.exe`（纯网关 + WebUI）+ `gbg-desktop.exe`（Tauri 托盘客户端）+ `gbg-desktop-compat.exe`（无 WebView2 / Win7 兼容托盘）
- **代理盾**：强制用 `127.0.0.1`，防止系统代理把本机网关搞挂
- **主题**：浅色 / 深色 / 跟随系统

## 原理

Grok Build 从 `~/.grok/config.toml` 读取 `base_url`，**不会热重载**。  
因此把 Grok 一次性指到本机网关；网关在内存里热切换上游、映射与候选链。

```
Grok Build  ──►  gbg :8787  ──►  candidate #1 → #2 → … (failover)
                 │
                 ├─ model map / multi-channel candidates
                 ├─ inject API key
                 ├─ protocol convert
                 └─ hot reload config (data/config.json)
```

## 三个发布产物

| 文件 | 用途 | 系统要求 |
|------|------|----------|
| `release/gbg.exe` | 纯网关 + 内嵌 WebUI（CLI / 无托盘） | 与 Bun 运行时一致（通常 Win10+） |
| `release/gbg-desktop.exe` | **单文件客户端**：内置网关 + 托盘 + 内嵌 WebView 窗口 | **需要 WebView2**（Win10/11 通常已装） |
| `release/gbg-desktop-compat.exe` | **兼容客户端**：内置网关 + 托盘，**无 WebView2**，WebUI 用系统浏览器 | **Win7+**，无需 Edge / WebView2 |

没有 WebView2、或仍在用 Windows 7 的用户请用 **`gbg-desktop-compat.exe`**。

### 打包

```bash
# 仅网关（CLI）
npm run build:exe

# 标准桌面客户端（Tauri / WebView2）
npm run build:desktop

# 兼容桌面客户端（无 WebView2 / Win7 向）
npm run build:desktop:compat

# 全部
npm run build:all
```

### 运行

**纯 WebUI / CLI：**

```bash
.\release\gbg.exe serve
# 浏览器打开 http://127.0.0.1:8787/
# 配置默认写在 release\data\config.json（与 exe 同级的 data/）
```

**标准桌面客户端（内置网关 + WebView2 窗口）：**

```bash
.\release\gbg-desktop.exe
```

- 首次运行将内置 `gbg` 解压到 `%LOCALAPPDATA%\GrokBuild-Gateway\runtime\` 并 **自动启动网关**
- 启动页可手动 **启动 / 停止**；托盘同样可操作
- 关窗口默认藏到托盘（不杀网关）；托盘「退出」会停网关
- **开机自启**：启动页开关
- 依赖系统 **WebView2**（Win10/11 通常已装）
- 可选：`--no-gateway` 只开壳不启网关；`GBG_PORT` 改端口

**兼容桌面客户端（无 WebView2 / 支持 Win7）：**

```bash
.\release\gbg-desktop-compat.exe
```

- **不依赖** WebView2 / Edge 运行时；PE 子系统目标为 Windows 7（`6.01`），静态链接 CRT
- 同样内置并自动启动网关；托盘左键打开系统默认浏览器中的 WebUI
- 托盘右键：打开 WebUI / 启动 / 停止 / 开机自启 / 关于 / 退出
- 参数：`--no-gateway`、`--autostart`、`--minimized`、`--no-open`
- 环境变量：`GBG_PORT`、`GBG_EXE`（覆盖内置网关路径）、`GBG_USE_EXTERNAL=1`
- 说明：内置 `gbg.exe` 由 Bun 编译，在极老系统上若无法启动，可用 `GBG_EXE` 指向本机 Node 启动的网关，或先 `gbg.exe serve` 再只跑壳

开发模式：

```bash
npm run dev                   # 网关（配置写在项目下 data/）
npm run dev:desktop           # 标准桌面壳（需本机已有 gbg / 或先 build:exe）
npm run dev:desktop:compat    # 兼容托盘壳
```

## 配置目录（data/）

> **变更说明**：旧版默认写在 `%USERPROFILE%\.gbg\`；现在默认改为**运行目录下的 `data/`**，便于绿色版 / 多开 / 随盘携带。

### 位置规则

| 场景 | 默认 data 目录 |
|------|----------------|
| 直接运行 `gbg.exe` | **exe 所在目录**下的 `data/`（例如 `D:\tools\gbg\data\`） |
| `npm run dev` / `tsx` 开发 | **当前工作目录**下的 `data/`（一般是仓库根目录） |
| 自定义 | 见下方环境变量 |

目录内容：

```text
data/
  config.json          # 主配置（供应商、映射、故障转移等）
  backups/             # 自动/手动备份
    before-reset.*.json
    before-restore.*.json
    config.toml.*      # apply-grok 时对 ~/.grok/config.toml 的备份也可能落在这里
```

### 环境变量

| 变量 | 作用 |
|------|------|
| `GBG_HOME` | 直接指定 data 目录（最高优先级），例如 `D:\gbg-data` |
| `GBG_ROOT` | 指定“运行根目录”，实际 data 为 `<GBG_ROOT>/data` |
| `GBG_PORT` | 桌面壳启动网关时的端口（可选） |

### 从旧版迁移

- 若新的 `data/config.json` **尚不存在**，而旧版 `%USERPROFILE%\.gbg\config.json` 存在，**首次启动会自动复制**到新位置（含尽力复制旧 backups）。
- 迁移后以 `data/` 为准；可用 `gbg config` 查看当前路径。

```bash
gbg config
# Data home : ...\data
# Config    : ...\data\config.json
# Backups   : ...
```

## 还原配置

还原前会**先备份当前** `config.json` 到 `data/backups/`，避免误操作丢配置。

### Web UI

总览页：

- **还原默认配置**：恢复出厂默认供应商/映射等（密钥等自定义会丢失，可从 backups 找回）
- **从备份还原**：使用 `data/backups/` 中**最近一次**备份

### CLI

```bash
# 查看 data 路径与备份列表
gbg config

# 还原出厂默认（会提示确认；--yes 跳过）
gbg reset-config --yes

# 从最近一次备份还原
gbg reset-config --from-backup --yes

# 指定备份文件名还原
gbg reset-config --from-backup before-reset.20260724_120000.json --yes
```

### API

```http
POST /api/config/reset
Content-Type: application/json

{ "mode": "defaults" }
```

```http
POST /api/config/reset
Content-Type: application/json

{ "mode": "backup", "backup": "可选-备份文件名" }
```

```http
GET /api/config/backups
```

## 多渠道候选链 & 故障转移

### 概念

- 普通映射：`from`（Grok 发出的模型名）→ `to`（上游模型）+ 可选 `providerId`
- **候选链** `candidates`：同一 `from` 可绑定多个「供应商 + 上游模型」，**数组顺序 = 优先级**
- 空 `providerId` 表示使用当前 **active** 供应商
- 未配置 `candidates` 的旧映射会自动归一成单候选，行为与以前一致

### 何时会切换渠道

在 `server.failover.enabled = true`（默认）且存在多个可用候选时：

| 情况 | 是否转移 |
|------|----------|
| 连接失败 / 网络错误 | 是 |
| 等待首字节超时（`firstByteTimeoutMs`） | 是 |
| HTTP 429 / 5xx | 是 |
| 多数 4xx（如 400/401/404） | **否**（避免无效重试） |
| 客户端取消 | 否 |
| **已经向客户端写出首字节**（含 SSE 已开始） | **否**（不中途换渠道） |

连续失败达到阈值后，渠道进入**冷却**（`cooldownMs`），期间优先跳过；全部冷却时仍会兜底再试。

### 配置示例（`data/config.json` 片段）

```json
{
  "modelMaps": [
    {
      "from": "grok-4.5",
      "to": "grok-4.5",
      "providerId": "okinto",
      "candidates": [
        { "providerId": "okinto", "model": "grok-4.5", "enabled": true },
        { "providerId": "ccx", "model": "grok-4.5", "enabled": true },
        { "providerId": "xai", "model": "grok-4.5", "enabled": true }
      ]
    }
  ],
  "server": {
    "failover": {
      "enabled": true,
      "maxAttempts": 3,
      "firstByteTimeoutMs": 30000,
      "cooldownMs": 60000,
      "consecutiveFailures": 2
    }
  }
}
```

### CLI / UI

```bash
# 设置映射 + 候选链（逗号分隔 provider:model；空 provider 表示 active）
gbg map set grok-4.5 grok-4.5 --candidates okinto:grok-4.5,ccx:grok-4.5

# 查看故障转移参数与渠道冷却健康
gbg failover
```

Web UI → **模型映射**：

- 表格展示候选链
- 表单「候选链」文本框：每行一个 `provider:model`，顺序即优先级
- 请求日志中可看到 `attempts` 轨迹（如 `okinto:502 > ccx:200`）

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

**推荐：一键写入**（自动备份 `~/.grok/config.toml`，地址为 `127.0.0.1`；模型显示名带 `(via GBG)` 后缀便于识别）

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
gbg map set grok-4.5 grok-4.5 --candidates okinto:grok-4.5,ccx:grok-4.5
gbg fetch-models okinto
gbg import-models okinto --target both --mode merge
```

Web UI → 模型映射中，点击 `to（上游 id）` 输入框会显示上游模型候选；候选只来自当前供应商 `/models` 拉取结果，点击后快速填入目标模型 ID，不会自动保存映射。多渠道请在「候选链」文本框中按行填写。

## CLI

| 命令 | 说明 |
|------|------|
| `gbg serve` | 启动网关 + Web UI |
| `gbg status` | 状态 |
| `gbg provider …` | 供应商 |
| `gbg map list` | 列出映射（含候选链） |
| `gbg map set <from> <to> [--provider id] [--candidates a:m1,b:m2]` | 设置映射 / 多渠道候选链 |
| `gbg map remove <from>` | 删除映射 |
| `gbg failover` | 故障转移配置与渠道冷却状态 |
| `gbg models` / `fetch-models` / `import-models` | 模型 |
| `gbg bootstrap` | 打印 Grok 配置片段 |
| `gbg apply-grok [--yes]` | 一键写入 Grok 配置 |
| `gbg doctor [--fix-proxy]` | 环境自检（含代理盾） |
| `gbg config` | 显示 data 目录、配置路径与备份列表 |
| `gbg reset-config [--yes] [--from-backup [name]]` | 还原默认配置 / 从备份还原 |

## 配置字段

主文件：`data/config.json`（路径见上文「配置目录」）。

关键字段：

- `activeProviderId` / `providers[]` / `modelMaps[]` / `virtualModels[]`
- `modelMaps[].candidates[]`：`{ providerId, model, enabled }`，顺序即优先级；`providerId` 为空字符串表示 active
- `server.failover`：
  - `enabled`（默认 `true`）
  - `maxAttempts`（默认 `3`）
  - `firstByteTimeoutMs`（默认 `30000`，决定是否换渠道的等待上限）
  - `cooldownMs`（默认 `60000`）
  - `consecutiveFailures`（默认 `2`，达阈值后冷却）
- `providers[].apiBackend`：`responses` / `chat_completions` / `messages`；新增供应商默认 `responses`，Anthropic 默认 `messages`
- `server.host` / `server.port`（默认 `127.0.0.1:8787`）
- `server.requestTimeoutMs`：完整请求/流超时（默认 `600000`）
- `server.proxyShield`：全局代理防护开关（默认 `true`；UI 可切换）
- `server.proxyMode`：`direct` / `env`（与 `proxyShield` 同步，兼容旧配置）
- `providers[].proxyShield`：单供应商代理防护（默认 `true`；仅全局开启时生效）
- `server.gatewayToken`：可选访问令牌

> 旧配置里已显式保存的 `apiBackend` **不会**被自动迁移改写。

## Web UI

- 总览 / 供应商 / 映射 / 虚拟模型 / 请求日志
- 主题：浅色 · 深色 · 跟随系统（`localStorage`）
- 顶栏 **代理盾** 状态徽章
- **总览**：
  - 全局代理防护开关
  - 显示 Config / Data 路径
  - **一键写入 Grok 配置** / 复制片段
  - **还原默认配置** / **从备份还原**
- **供应商**：列表与编辑表单均可单独开关代理防护
- **模型映射**：
  - 目标模型 ID 快速填入（仅来自上游 `/models`）
  - 多渠道候选链编辑与展示
- **请求日志**：状态、耗时分段、failover `attempts` 轨迹

## Control API（摘要）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/health` | 健康、`publicBase`、`configPath`、`dataHome`、`proxyShield`、`failover`、`providerHealth` |
| GET | `/api/snapshot` | UI 轮询（可 204） |
| GET | `/api/config` | 脱敏后的完整配置 |
| GET | `/api/config/backups` | 配置备份列表 |
| POST | `/api/config/reset` | 还原默认或从备份还原（先备份当前） |
| POST | `/api/active-provider` | 热切换供应商 |
| POST | `/api/apply-grok` | 一键写 Grok 配置 |
| GET | `/api/failover` | 故障转移参数与渠道健康 |

OpenAI / Anthropic 兼容：`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。

## 验证

协议或网关转换相关改动至少跑：

```bash
npm test -- --run tests/protocol.test.ts tests/proxy-protocol.test.ts
npm run typecheck
```

发布前：

```bash
npm test
npm run build:desktop
npm run build:desktop:compat
```

## 安全说明

- 默认只绑定 `127.0.0.1`
- 密钥脱敏；推荐 `apiKey: "env:VAR"`
- 不默认修改系统全局代理设置
- 还原配置会备份，但仍请勿把含明文密钥的 `data/` 提交到公开仓库

## License

MIT
