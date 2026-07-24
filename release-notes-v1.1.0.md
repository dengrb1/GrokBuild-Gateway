## GrokBuild Gateway v1.1.0

基于 v1.1.0-beta.1 的正式版。聚焦流式代理稳定性、协议转换正确性，以及无 WebView2 的兼容桌面形态。

### 下载说明

| 文件 | 说明 | 适用场景 |
|------|------|----------|
| **gbg-desktop.exe** | 标准桌面客户端：内置网关 + 托盘 + WebView 窗口 | **推荐日常使用**（需 WebView2） |
| **gbg-desktop-compat.exe** | 兼容桌面客户端：托盘 + 系统浏览器打开 WebUI | **Win7 / 无 WebView2** |
| **gbg.exe** | 纯网关 + 内嵌 WebUI（CLI，无托盘） | 服务器 / 脚本 / 仅命令行 |

### 主要更新

- 强化流式代理生命周期、超时、客户端取消与上游 socket 失败上报
- 增加请求体、上游 header、首字节与完整流的分段耗时诊断
- 修复 Responses tool-call id、并行/交错参数 delta、仅最终输出的 tool call，以及 strict 工具字段保留
- 新增无 WebView2 依赖的桌面兼容构建
- 写入 Grok 配置时模型显示名恢复/保留 `(via GBG)` 后缀
- 模型映射支持多渠道候选链与首字节前故障转移（429/5xx/超时/网络错误）

### 快速开始

1. 下载对应 exe
2. 标准版双击运行（需 WebView2）；兼容版会用系统浏览器打开 WebUI
3. 配置供应商与 API Key，使用「一键写入 Grok 配置」后重启一次 Grok

### 验证

- `npm test`
- `npm run typecheck`
- `npm run build:all`

### 完整文档

详见仓库 [README](https://github.com/dengrb1/GrokBuild-Gateway/blob/main/README.md)。
