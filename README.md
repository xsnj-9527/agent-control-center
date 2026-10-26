# Agent Control Center v0.3.2

面向 Codex、OpenCode、DSH、Claude Code 的 Windows x64 桌面控制中心。使用 Electron，本地运行。

## 安装与升级

[在 GitHub Release 下载 Windows 安装包](https://github.com/xsnj-9527/agent-control-center/releases/latest)。

双击第三版 `Agent-Control-Center-Setup-0.3.2.exe`。Squirrel 安装器会为当前用户安装应用，创建桌面和开始菜单快捷方式；沿用此前版本的应用标识与本地设置。升级前先退出旧版。

安装包未代码签名。Windows 可能显示发行者未知。

## 四种 Agent 接入

| Agent | 历史来源 | 任务控制 | 本机验证版本 |
| --- | --- | --- | --- |
| Codex | `CODEX_HOME` 或 `~/.codex` 的 SQLite、JSONL | 原生 app-server 标准输入输出协议 | 0.164.0-alpha.11.1 |
| OpenCode | `~/.local/share/opencode/opencode.db` 的 v2 表 | 独立、带随机密码的 localhost v2 服务 | 2.0.22 |
| DSH | `DSH_HOME` 或 `~/.dsh`，支持多帧 Zstandard 会话 | headless 配置叠加本应用的控制桥；使用原生 Agent / Session / Approval 服务 | 0.1.1-rc.2 |
| Claude Code | `CLAUDE_CONFIG_DIR` 或 `~/.claude/projects` 的 JSONL | 双向 stream-json 与原生权限处理 | 2.1.300 |

点击 Agent 行的“设置”可以更换数据目录或 CLI。默认检测 PATH 和常见 npm 安装目录，使用真实 `.exe` / Node `.js` 入口，不经 PowerShell 或 CMD 拼接任务文本。DSH 使用其已安装包及依赖，模型沿用本机默认配置。CLI 接口及本地存储格式可能随版本变化。

历史记录读取不会修改源文件，也不会读取认证文件。每种 Agent 最多读取最近 200 个会话；Codex 单文件上限 64 MiB，Claude / DSH 的单文件及解压结果上限 32 MiB，递归发现最多 5000 个文件。超限、旧格式、损坏或写入中的记录会显示不完整；缺失记录不以演示值填补。

## 实时任务与工作区

1. 点击“新建任务”，选择 Agent、工作区，输入任务；可选指定模型。OpenCode 模型格式为 `provider/model#variant`，variant 可省略。
2. 确认窗口说明工作区、任务和可能产生的文件修改与模型费用。
3. 在任务列表查看启动、执行、等待审批、取消、完成和失败状态，展开实时日志。每种 Agent 同时运行一个受控任务。
4. 工具权限支持“允许本次 / 拒绝”，不自动永久放行。普通提问支持选项与文本答复。OpenCode 外部表单需要到原生客户端续接。
5. “取消”先调用原生中断；没有及时退出时，仅清理控制中心持有的子进程树。“续接”沿用原会话 ID 与工作区，输入下一步任务。
6. 关闭应用时若仍有任务，会要求选择继续运行或取消后退出。异常退出的记录标记为中断；再次续接前请确认原任务已停止。

外部客户端启动的任务只读取历史，不接管或结束其进程。状态来自原生事件及进程退出，不生成执行百分比。Claude 的后台 Agent 未结束时继续等待。DSH 的文本在原生持久事件产生时更新，可能以整条回复显示。

任务说明、工作区、脱敏后的日志与采集用量保存在本应用数据目录 `control.sqlite`。日志只保留每个任务最近 2000 条，界面显示最近 500 条；常见密钥会隐藏，但请避免在任务或工具输出中放入凭据。提问答复不另存到控制中心日志，Agent 自身仍按原生规则保存会话。

渲染进程启用沙箱、上下文隔离，无 Node 权限或直接网络访问；仅暴露固定 IPC 方法，并校验主窗口来源。Agent 本身使用已有登录、模型路由和项目配置，执行时会按原生行为访问供应商或工具。

## 用量与本地成本台账

- 近七天按 UTC+8 自然日汇总。以 Agent ＋响应 ID 去重，避免分支和分块响应重复计算。
- 缓存读写归入输入 Token；估算时将普通输入、缓存读、缓存写、输出分别定价，不重复累加。
- “已记录费用”来自 OpenCode 的原生费用字段，及受控 Claude 任务的原生结果；这仍然是本地记录，不代表供应商实际扣款。
- 其他响应可在“编辑费率”中填写每百万 Token 单价，按 Agent、供应商和完整模型名精确匹配。未填写的模型标为未定价，不视为零费用。
- Claude 受控任务的原生费用覆盖对应响应估算，汇总费用按任务结束日入账；金额计算用整数纳币单位，每响应四舍五入到 9 位小数。
- USD 与 CNY 分开汇总，不自动换汇。账期和 Agent 可筛选，估算随费率编辑即时重算，已记录费用保留原值。
- CSV 导入用于独立对账，不重复加到本地成本中；未导入账单时不显示对账差额。可删除误导入记录。

导入 CSV 表头固定为：

```csv
id,date,agent,amount,currency,note
invoice-001,2026-10-25,codex,1.250000000,USD,"供应商账单，备注"
refund-001,2026-10-25,codex,-0.250000000,USD,退款
```

`agent` 为 `codex/opencode/dsh/claude`，日期为 `YYYY-MM-DD`，币种为 `USD/CNY`。文件最大 5 MB、10000 行，支持引号、逗号和多行备注。同 ID 相同内容重复导入会跳过；同 ID 内容冲突会整批回滚。导出台账会防护电子表格公式注入。

## 开发与打包

使用 Node.js 24（本机 24.19.0 已验证），执行：

```text
npm ci
node node_modules/electron/install.js
npm start
npm test
npm run make
```

构建使用 Electron 45.0.0 / Forge 8.0.1。Windows 打包脚本临时映射项目父目录到空闲盘符，兼容 Squirrel 资源工具的中文路径限制，并在结束后解除映射。测试与构建脚本不会进入生产 ASAR。

本次验证包含：单元测试、四种真实本地数据只读接入、原生协议初始化 / 服务鉴权 / DSH 控制桥自检、隔离资料的 Electron 界面和打包产物启动。未发送付费模型任务；真实任务执行还取决于各 CLI 的登录、权限与模型服务可用性。

此前受限执行环境下的 `0x80000003` 不代表正常 Windows 桌面启动失败；应用内 Electron 渲染沙箱仍保持启用。
