# 手动配置 Codex MCP

[English](manual-configuration.md) | **简体中文**

优先使用 setup 预览和冲突检查。安装器无法写入目标文件，或需要明确指定环境变量时，再手动配置。

Codex 通常使用 `~/.codex/config.toml`；已有 `CODEX_HOME` 会改变该根目录。编辑前备份文件，保留无关 server。参见 [Codex MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp)。

## 构建并定位入口

```sh
npm ci
npm run build
```

配置中使用实际 Node 可执行文件及 checkout 的 `dist/index.js` 绝对路径。PowerShell 用 `(Get-Command node).Source`，macOS 用 `command -v node` 查找 Node。安装后保持这两个路径稳定。

## Windows 或 macOS 官方 Desktop

```toml
[mcp_servers.dsh_agentlink]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/Codex-DSH-Orchestrator/dist/index.js"]
env_vars = ["DSH_CONNECT_TOKEN", "DSH_CONNECT_ORIGIN"]

[mcp_servers.dsh_agentlink.env]
DSH_HOST_PROTOCOL = "gateway"
DSH_HOST_MODE = "desktop-auto"

[mcp_servers.dsh_agentlink.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

对应安装器预览：

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run
```

这种配置省略静态 `DSH_HOST_URL`、旧版本声明和 preset 覆盖。`DSH_CONNECT_ORIGIN` 在内存中把授权绑定到操作系统确认归属的 listener，不是静态地址覆盖。若显式设置 URL，运行时会改用静态模式。

setup 只声明授权变量名称。私有启动交接把值传给新 Codex 进程，操作见[启动说明](official-desktop-gateway.md#operator-startup)。该步骤会启动应用，需要先约定空窗。Provider API key 不能替代 Gateway 启动授权。

需要静态官方 Gateway 时，用 `DSH_HOST_URL = "http://127.0.0.1:3080"` 替换 `DSH_HOST_MODE`，地址以实际获授权 origin 为准。安装器接受 `--gateway --host <origin> --no-preset`。

## Skill 范围与重载

安装器复制 `skill/codex-dsh-orchestrator/SKILL.md` 和 `agents/openai.yaml`，默认目标是仓库范围的 `.agents/skills/codex-dsh-orchestrator/`。跨项目安装使用 `--skill-path "$HOME/.agents/skills/codex-dsh-orchestrator"`。已有 `~/.codex/skills` 全局安装可原地更新，每个名称保留一个可发现副本。

MCP 冲突需要 `--replace`，Skill 内容冲突需要 `--replace-skill`，分别审查。安装器检查符号链接、非普通文件并创建替换备份；若报告部分成功，先检查两项结果再重试。

修改 MCP 配置后在约定空窗重载调用方，通过 `/mcp` 或设置确认。Skill 用 `/skills` 或显式 `$codex-dsh-orchestrator` 单独确认。`dsh_resolve_approval` 保留 `approval_mode = "prompt"`。

发现 `dsh_collab` 时，按选定协议预览迁移并审查 `--replace`，最终保留一个 `dsh_agentlink`。保存回滚备份，恢复前检查后续改动。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `DSH_HOST_PROTOCOL` | 默认 `legacy`，显式选择 `gateway` |
| `DSH_HOST_MODE` | 默认 `static`；官方自动发现支持 Win/Mac，legacy 自动发现支持 Windows |
| `DSH_HOST_URL` | 静态 origin；默认 loopback 3080，显式设置时覆盖 auto 模式 |
| `DSH_CONNECT_TOKEN` | 来自私有调用方环境的 Gateway 授权，值不写入文件或 prompt |
| `DSH_CONNECT_ORIGIN` | 授权绑定的 origin，也约束官方自动发现 |
| `DSH_CONNECT_TOKEN_ENV` | 可选的运行时输入变量名称，setup 使用标准名称 |
| `DSH_HOME` | 推导 bridge 状态目录的根，默认 `~/.dsh` |
| `DSH_BRIDGE_HOME` | 本地协作状态目录，默认 `~/.dsh/codex-bridge` |
| `DSH_REQUEST_TIMEOUT_MS` | unary/连接超时，默认 30000 ms，不是任务总时限 |
| `DSH_BRIDGE_AGENT_PRESET` | 可选 composition/preset 覆盖，省略时跟随 DSH |
| `DSH_BRIDGE_TIME_ZONE` | prompt 的可选 IANA 时区 |
| `DSH_HOST_VERSION` | 操作方版本声明，与真实产品/协议验证分开 |
| `DSH_APPROVAL_TIMEOUT_MS` | 连接存活期间可选的尽力拒绝审批计时器，默认关闭；定时问题由另一套机制处理 |
| `DSH_ALLOW_REMOTE_HOST=true` | 显式信任非 loopback 静态部署 |

doctor 只读报告选定 home 的锁结构，保留锁文件。Gateway admission 保持 `not_probed`；另行批准的 `dsh_host_status` 才会认证并建立 API Peer。

省略策略/档位字段时继承路由。模型与 effort 都需要当前目录证据，显式选择可能保存为 DSH 默认值。Workspace claim 协调 bridge 活动，文件系统权限由 DSH 执行。见 [Gateway 能力](official-desktop-gateway.md#models-and-capabilities)。

## 旧版 Host

legacy 协议面向此前验证的 DSH CLI `0.1.0-rc.6` Web Host 和 Windows 社区 Desktop，使用独立 adapter。

```toml
[mcp_servers.dsh_agentlink]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/Codex-DSH-Orchestrator/dist/index.js"]

[mcp_servers.dsh_agentlink.env]
DSH_HOST_PROTOCOL = "legacy"
DSH_HOST_URL = "http://127.0.0.1:3080"

[mcp_servers.dsh_agentlink.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

静态安装要求 `dsh --version` 可用；Windows 社区 Desktop 可以使用 `npm run setup -- --desktop-auto --no-preset`。该发现路径检查精确 `DSH Desktop.exe` 所属 listener，以 `host.describe` 验证 loopback 候选；官方 Desktop 则要加 `--gateway`。

legacy rc.6 Web API 没有 token 认证，`host.describe.version` 的占位值 `0.0.1` 不是包版本。启动和登录由用户负责。若决定自行启动旧 CLI Host，`dsh web --host 127.0.0.1 --port 3080` 会启动它，随后用 `npm run doctor` 检查 legacy 能力。

故障或过大的 bridge 状态应保留备查，新 home 的 mapping/cursor/claim 重新开始。清理锁前先读[已知问题](../KNOWN_ISSUES.md)。

本项目不是 DSH Cordis bundle，请勿使用 `dsh plugin --profile ... add ...` 安装。
