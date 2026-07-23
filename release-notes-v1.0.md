## GrokBuild Gateway v1.0

首个正式版本发布。面向 Grok Build 的本地供应商 / 模型切换网关，切换上游无需重启 Grok。

### 下载说明（两个版本）

| 文件 | 说明 | 适用场景 |
|------|------|----------|
| **gbg-desktop.exe** | 桌面客户端（单文件）：内置网关 + 系统托盘 + 启停 + 开机自启 | **推荐日常使用**（需 WebView2） |
| **gbg-desktop-compat.exe** | 兼容桌面客户端：无 WebView2，托盘 + 系统浏览器 WebUI | **Win7 / 无 WebView2** 用户 |
| **gbg.exe** | 纯网关 + 内嵌 WebUI（CLI，无托盘） | 服务器 / 脚本 / 仅需命令行场景 |

请按需下载对应版本，二者功能核心相同，部署形态不同。

### 主要功能

- 多供应商档案：Okinto / CCX / xAI / Anthropic / OpenAI Responses / 自定义
- 模型映射：Grok 发出的模型名 → 上游真实模型名（可按映射钉死供应商）
- 本地热切换网关：Grok 固定指向 `http://127.0.0.1:8787/v1`，切换供应商无需重启 Grok
- 三协议互转：`chat_completions` / `responses` / `messages`（含 Tools / SSE）
- 代理盾：强制使用 `127.0.0.1`，降低系统代理劫持本机网关的风险
- 主题：浅色 / 深色 / 跟随系统

### 快速开始

**桌面版（推荐）**

1. 下载 `gbg-desktop.exe`（有 WebView2 时）或 `gbg-desktop-compat.exe`（Win7 / 无 WebView2）
2. 双击运行；标准版依赖系统 WebView2（Win10/11 通常已预装），兼容版用系统浏览器打开 WebUI
3. 首次运行会将内置网关解压到 `%LOCALAPPDATA%\GrokBuild-Gateway\runtime\` 并自动启动
4. 在界面中配置供应商与 API Key，使用「一键写入 Grok 配置」后重启一次 Grok 即可

**CLI / 纯网关版**

```powershell
.\gbg.exe serve
# 浏览器打开 http://127.0.0.1:8787/
```

### 运行注意

- 关窗口默认藏到托盘（不停止网关）；托盘「退出」会停止网关
- 可选参数：`--no-gateway` 只开壳不启网关；环境变量 `GBG_PORT` 可改端口
- Windows 系统代理建议勾选「请勿将代理服务器用于本地 (Intranet) 地址」，或在例外中加入 `127.0.0.1`

### 系统要求

- Windows 10 / 11
- 标准桌面版需要 WebView2 运行时；无 WebView2 / Win7 请用 `gbg-desktop-compat.exe`

### 完整文档

详见仓库 [README](https://github.com/dengrb1/GrokBuild-Gateway/blob/main/README.md)。
