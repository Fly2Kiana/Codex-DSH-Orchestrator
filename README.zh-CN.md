# Codex-DSH-Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![DSH bridge](https://img.shields.io/badge/DSH-bridge-4B6BFB?style=flat-square)](https://www.deepseek.com/harness/en/)

[English](README.md) | **简体中文**

Codex-DSH-Orchestrator 是一个以 Codex 为主要入口的编排层和调用方 MCP bridge，用于让 Codex 与 DeepSeek Harness（DSH）进行有边界的协作。Codex 可以把实现、调研、调试和长日志整理等任务交给 DSH，再在原有工作流中观察、继续或取消对应会话。共享调用方集成层仍支持 Claude Code；ZCode、OpenCode、Workbuddy 等调用方会在真实宿主行为得到验证后再适配。

本仓库中的共享 bridge runtime 是基于上游 [dsh-Agentlink 项目](https://github.com/hootandy321/dsh-Agentlink) 独立维护的派生组件。本项目保留上游 MIT 许可证和版权归属，不隶属于 DeepSeek、OpenAI 或上游维护者，也不代表其官方背书。

## 项目边界

Codex-DSH-Orchestrator 是调用方一侧的编排与 MCP bridge 项目。它连接已支持的调用方与独立运行的 DSH Web Host；不会启动、拥有或为该 Host 提供身份认证，也不会自动批准 DSH 请求。它不是 DSH Cordis bundle。

## 项目组成

- skill/codex-dsh-orchestrator/ — 本项目的 Codex 编排 skill 及其 agent 元数据。
- skill/codex-dsh/ — 共享的 Codex 调用方兼容 skill。
- skill/claude-code-dsh/ — 保留的 Claude Code 调用方兼容 skill。
- src/ — 共享的、与调用方无关的 MCP bridge runtime 和配置工具。
- test/ — 本地 mock Host、安全、兼容性和集成测试。
- docs/project-overview.zh-CN.md — 详细的归属与架构关系说明。

dsh-Agentlink 名称因运行时兼容性和法律归属继续出现在标识符与上游说明中，但它不是本项目的公开标题。

## 调用方支持情况

| 调用方 | 状态 | 安装方式或可用性 |
|---|---|---|
| Codex | ✅ 已支持 | `npm run setup` |
| Claude Code | ✅ 已支持 | `npm run setup:claude -- --project /项目的绝对路径` |
| ZCode | ⏸ 已延期 | 恢复调用方扩展时的首个候选 |
| OpenCode | ⏳ 待适配 | 尚不可用 |
| Workbuddy | ⏳ 待适配 | 尚不可用 |

目前只有标记为**已支持**的调用方在本仓库中提供可用安装路径。“已延期”和“待适配”是当前方向，不代表发布承诺。

## 安装

安装前先准备环境：只需要 **Node.js 22+**、一个已支持的调用方（**Codex 或 Claude Code**）和可以正常运行的 **DSH CLI**。当前跨平台测试基线是 x64 Node.js 22 和 24；其他 Node.js 主版本和 ARM64 环境不在现有矩阵覆盖范围内。先在 DSH 中配置一次你希望使用的模型；除非某次委派显式请求受支持的语义档位，否则共享 bridge 会继承当前路由。

### 可移植性与安装边界

- 换到另一台机器时请重新 clone。不要直接复制单个 worktree 目录：其中的 `.git` 文件指向原始 clone 的 worktree 元数据。同一台机器上需要 worktree 时，请从源 clone 使用 `git worktree add` 创建。
- 干净、可复现的 checkout 优先使用 `npm ci`；只有在明确要更新 lockfile 时才使用 `npm install`。
- `npm run setup` 会把 Node.js 可执行文件和构建后的 bridge 入口的绝对路径写入调用方配置。请把 checkout 放在稳定的工具目录；移动目录、更换 Node.js 安装或切换 worktree 后，应重新构建并运行 setup，先审查已有条目，再在明确授权后使用 `--replace`。
- Codex MCP 配置与 Codex skill 安装是两件事。`npm run setup` 只注册 MCP 入口，不会安装 `skill/codex-dsh-orchestrator/`。请通过平时的 Codex skill 安装流程单独安装并启用该 skill，然后确认它可被发现，再使用 `$codex-dsh-orchestrator`。Claude Code 的项目 skill 由下文的 Claude setup 单独管理。
- `DSH_BRIDGE_HOME` 应位于可靠的本地文件系统。不要把旧 bridge home 复制到另一台机器；新机器请使用新的 home。DSH 对话历史归 DSH Web Host 所有，而 bridge 的任务映射、cursor 和 claim 不会自动迁移。
- Windows `desktop-auto` 是显式选择的模式。它要求 DSH Desktop Host 已经运行，并满足受支持的 Windows 进程/loopback 发现前置条件；CI 只 mock 这些行为，不代表真实 Desktop 的安装或登录已验收。配置工具不会启动、关闭或登录 DSH Desktop。

### 让你的 AI agent 帮你安装

把下面的仓库地址和指令直接发给 Codex 或其他 coding agent：

```text
请从 https://github.com/Fly2Kiana/Codex-DSH-Orchestrator 安装 Codex-DSH-Orchestrator。
先检查 Node.js 22+、DSH CLI 和我的 DSH Web Host，在我确认的目录中 clone；
运行 npm ci 和 npm run check。Codex 使用 npm run setup -- --yes，然后通过我平时的 Codex skill 流程单独安装并验收仓库提供的 skill；Claude Code 使用
npm run setup:claude -- --yes --project /项目的绝对路径。
Claude Code 会安装项目 MCP 入口和随仓库提供的项目 skill；只有在审查已有文件后再使用 --replace 和 --replace-skill。
如果已经存在 dsh_agentlink 或旧版 dsh_collab 配置，先向我展示冲突，再决定是否使用 --replace。
不要替我启动或停止 dsh web，完成后告诉我何时需要重载调用方并完成项目级 MCP 的信任确认。
```

### 手动安装

1. 检查环境。当前经过测试的 DSH CLI 目标是 `0.1.0-rc.6`。

   ```bash
   node --version
   dsh --version
   ```

2. 在独立终端启动官方 DSH Web Host。

   ```bash
   dsh web
   ```

3. 克隆仓库并安装依赖。

   ```bash
   git clone https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git
   cd Codex-DSH-Orchestrator
   npm ci
   ```

4. 配置你使用的调用方。

   Codex：

   ```bash
   npm run setup
   npm run doctor
   ```

   Windows 上使用临时 loopback 端口的 DSH Desktop 时，请显式选择自动发现：

   ```bash
   npm run setup -- --desktop-auto
   ```

   Codex 向导会备份 TOML 配置，并以 `approval_mode = "prompt"` 安装 MCP 入口，但不会安装 `skill/codex-dsh-orchestrator/`；请通过平时的 Codex skill 流程单独安装并确认它可被发现。静态模式仍要求 `dsh --version` 可用；`--desktop-auto` 可在 CLI 不在 `PATH` 时改由已运行的 Desktop Host capability 验证，并把缺少 package 版本作为兼容性警告报告。向导绝不会启动或关闭 DSH Desktop。已有 bridge 条目切换任一模式仍需先检查，再显式增加 `--replace`。重启 Codex 后，通过 `/mcp` 或 Codex 设置确认 `dsh_agentlink` 已连接。需要手动 TOML 配置时，参见[Codex MCP 手动配置](docs/manual-configuration.zh-CN.md)。

   Claude Code 2.1.199 或更高版本：

   ```bash
   npm run setup:claude -- --project /你的项目绝对路径
   cd /你的项目绝对路径
   claude mcp get dsh_agentlink
   ```

   Claude 向导只修改该项目的 `.mcp.json` 和 `.claude/skills/claude-code-dsh/SKILL.md`，并保留其他无关的 server 配置。它会分别报告以下各项：

   - MCP 注册
   - 项目级 MCP 信任状态
   - Claude skill 状态
   - Claude 审批能力
   - DSH permission/sandbox 归属
   - DSH Host 可达性

   在该项目中打开 Claude Code，通过 `/mcp` 批准 pending server；bridge 会把 `dsh_resolve_approval` 标记为必须人工交互。

   无交互使用默认值时增加 `--yes`。需要更新已有 MCP 条目时，请先检查原配置，再增加 `--replace`；需要更新已有的 Claude 项目 skill 时，请先审查后增加 `--replace-skill`；如果要自己管理 skill，则增加 `--no-skill`。两个配置工具都会识别旧版 `dsh_collab`，并且只在得到这次明确的替换授权后迁移为 `dsh_agentlink`。它们不会启动 DSH、不会改变 DSH permission/sandbox 设置，也不会替你重启调用方。

doctor 会以只读方式报告 `DSH_BRIDGE_HOME` 下的 fail-closed 锁位置，且从不清理它们，因此即使存在锁也能安全运行。

当前源码补丁会阻止新的 projection/chunk 洪峰继续扩大 coordination ledger，但不会自动压缩已有的 5 MB 以上 ledger。请保留旧 bridge home 备查；新的委派可以选择独立的 `DSH_BRIDGE_HOME`。对话真源始终是 DSH `session.history`，不是 bridge ledger。保守恢复边界见[已知问题](KNOWN_ISSUES.md)。

这个 bridge（运行时名称为 `dsh_agentlink`）安装在调用方一侧，不是 DSH Cordis bundle；请不要使用 `dsh plugin --profile ... add ...` 安装。

## 为什么需要 Codex-DSH-Orchestrator？

### 利用 DSH 的 Harness 能力

DSH 为复杂任务提供持久 session、工具调用、subagent 和人工监督等能力。Codex-DSH-Orchestrator 让你的主调用方（当前为 Codex 或 Claude Code）能够与这套独立 harness 讨论并协作，同时不离开原本的工作入口。

### 不只是再增加一个原生 subagent

原生 subagent 仍属于调用方自己的 agent tree。共享 bridge 接入的是一套由用户配置的独立 harness：会话可以在 DSH Web 持续查看，使用 DSH 自己的 worker 与模型路由，并由主调用方观察、继续或取消。

### 省时间、也省成本

- **省时间。** 把实现、检索、资料提取和长日志整理等执行型任务交给你在 DSH 中配置的高速模型，例如 DeepSeek V4 路由，主 agent 可以继续规划和验收。
- **省成本。** 把大量执行 token 路由到成本更低的 DeepSeek 模型，可以减少对昂贵主模型的消耗。

实际速度和费用取决于模型、服务商、部署方式、网络与任务本身。完成安装后，你仍然可以像平常一样使用 Codex 或 Claude Code，只在适合交给 DSH 执行时直接让它发起委派即可。

## 如何使用

启动 `dsh web`，并让调用方加载、信任 MCP 配置后，直接用自然语言告诉 Codex 或 Claude Code，例如：

> 使用 Codex-DSH-Orchestrator，把当前仓库里的这个实现任务委派给 DSH。保持会话在 DSH Web 可见，向我报告进度，任何 approval 都先询问我。

之后调用方可以委派任务、观察事件、继续同一会话、与你一起回答 DSH 的问题，或取消任务。打开已配置的 DSH Web origin，即可查看并操作同一个 session。在 Windows 上可显式设置 `DSH_HOST_MODE=desktop-auto`，让运行时发现并验证 DSH Desktop 所属的 loopback listener，避免依赖会变化的临时端口；显式 `DSH_HOST_URL` 永远优先。

发起新委派前，调用方会把已知进度与只读工作区证据整理成简短 handoff 写入 prompt：目标、已完成内容、可用时的 Git HEAD/status 与变更路径、优先代码/Markdown 路径、相关测试、约束和未解决问题，并要求 DSH 先读优先路径，只有受阻时才扩大到全仓库扫描。handoff 不包含凭据、原始大段 diff、文件全文、调用方聊天记录或内部推理。这只是调用方工作流指导，不是新的文件系统授权；dsh-Agentlink 不会自动取得调用方先前的对话状态。同一项工作且已知 BridgeTask id 时使用 `dsh_followup`；不知道匹配 id 时新建委派，不猜测旧任务。

用户明确指出某个已有 DSH Desktop 会话时，调用方可以先用 `dsh_find_sessions` 读取有界的 root-session 元数据，再用精确 session id 和新鲜元数据前置条件调用 `dsh_attach_session`。标题只用于发现，绝不作为接管身份。接管只接受空闲 root session，创建或复用 bridge-local mapping 与 workspace claim，并可能为了监督而 reconcile history，但不会返回或持久化对话正文。它也不会创建或重命名 DSH session、发送 prompt 或改变模型路由。需要继续工作时，再由后续 `dsh_followup` 发送 compact handoff。

跨 Codex 任务复用会话是保守的三选一：`same-known-task`、`attached-existing-task` 或 `new-session`。只在同一工作流中复用已知的 BridgeTask；新任务若有明确的延续证据，应通过仅读元数据的 `dsh_find_sessions`，以精确 canonical cwd 加上 mapped、idle 过滤，找到唯一候选，并以新鲜前置条件接管后再继续。绝不按标题或相似度复用，也绝不为发现而读取 history；遇到歧义、运行中、过期、缺少 cwd 或映射冲突的候选一律失败关闭。复用可以节省交接与重复读取仓库的成本，但也可能增加输入 token，因此只有在延续性仍然相关时才是成本优化。复用与减少的重复读取并不证明 provider prompt-cache 命中或 token 折扣；除非 DSH 提供文档化的聚合用量遥测，否则 provider cache 证据不会被暴露。

## MCP 工具

- `dsh_host_status` — 读取 connect-only Host 状态与 capabilities
- `dsh_find_sessions` — 只读取已有 root session 的有界元数据；不读取 history 或返回 raw projections
- `dsh_attach_session` — 使用精确 id/title/cwd/update 前置条件安全接管一个空闲 root session；不发送 prompt 或改变模型
- `dsh_delegate` — 创建 root session 并排队初始 prompt；可选 `inherit|flash|pro|modlens-flash|modlens-pro` 和 catalog 支持的 `reasoningEffort`；默认 detached（`waitSeconds=0`）；`workspaceMode` 是 bridge-local claim，不是 DSH sandbox selector
- `dsh_followup` — 以显式 `mode="queue"|"steer"` 继续同一个 root session；默认 `queue`；可在 prompt 前选择相同的语义模型档位与已校验 reasoning effort
- `dsh_continue` — `dsh_followup` 的兼容别名
- `dsh_status` — 返回 availability、execution、lineage、queue、pending interaction、final message、cursors 和 workspace claim semantics
- `dsh_tail` — 使用 bridge task cursor 读取有界事件摘要
- `dsh_wait` — 最多等待 30 秒，直到出现 durable event、状态变化、pending interaction 或 terminal 状态
- `dsh_observe` — `dsh_wait` 的兼容别名；bridge cursor 取代原始 per-session seq cursor
- `dsh_cancel` — `scope="turn"|"queue"`
- `dsh_list` — 列出 task mapping，并附带当前派生状态
- `dsh_answer_question` — 通过 pending question rpcId 提交类型化答案
- `dsh_resolve_approval` — 对 pending approval rpcId 提交 `allow_once|reject`
- `dsh_release_workspace` — 显式释放持久化 workspace claim，但不关闭 DSH session

模型路由对委派与 follow-up 都是可选且向后兼容的。省略 `modelProfile` 和 `reasoningEffort` 时，操作只读取 `session.models.current`、验证 `routable`，不会调用 `session.selectModel`。语义映射为：`flash`/`pro` -> `deepseek-official/deepseek-v4-{flash,pro}`，`modlens-flash`/`modlens-pro` -> `deepseek-modlens/deepseek-v4-{flash,pro}`。请求的 provider、model 和推理等级必须存在于实时 `session.models` catalog 中。bridge 会在初始或 follow-up prompt 前完成选择并重新读取验证；任何不一致都会失败关闭，不发送该 prompt。

用户明确指定永远优先。用户未指定时，主调用方可以保持 `inherit`；常规搜索、实现和测试修复使用 Flash；架构设计或困难的多步骤调试使用 Pro；视觉证据不可缺少时使用对应的 ModLens 档位。dsh-Agentlink 只传输文本 prompt：请把 DSH Host 与 ModLens 工具可访问的本地图片绝对路径写进 prompt；bridge 不上传图片字节。`selectionReason` 可记录调用方为何做出显式或自主选择，但不会发送给 DSH。

**DSH rc.6 的重要副作用：** `session.selectModel` 也会把本次选择保存成 DSH 的全局默认值，影响后续 session。显式选择时，delegate 与 follow-up 返回结果都会包含 `modelRouting.persistsAsDshDefault=true` 和警告。如果不接受这个持久化副作用，请省略路由字段。如果写入模型选择后验证失败，则不会发送 prompt，但该选择可能已经成为全局默认值。

`dsh_wait` 只观察 bridge 的持久化状态。assistant delta/chunk 帧和顶层 `session/projection` snapshot 会被跳过，因此不会 bump task revision，也不会唤醒 waiter；turn 结束后的完整 final message 仍可通过 status/tail 观察。

## 后续方向

以下内容是计划方向，不代表已经实现或 release 承诺。

1. **更多调用方入口** — 恢复调用方扩展时优先评估 ZCode，再通过共享 Integration Pack 架构考虑 OpenCode、Workbuddy、Claude Desktop MCP 等调用方。
2. **Agent 调用与信息传输** — 优化 prompt 组织、上下文打包、输出摘要和压缩策略，同时确保问题、审批、错误和最终答案可靠传输。
3. **支持 DSH 插件能力的 session** — 保留当前面向 preset 型插件的 `agentPreset` 路径，增加只读 preset/能力校验和已解析 preset 的报告；只有真实插件证明需要创建后的类型化初始化时，才引入声明式 session launch profile。
4. **更多集成** — 待共享 Runtime 与调用方兼容性约定稳定后继续扩展。

## 更多文档

- [项目概览](docs/project-overview.zh-CN.md) — 公开身份、组件归属和 Codex-first 架构
- [架构与安全模型](docs/architecture.zh-CN.md) — 身份、状态、恢复、审批、取消与工作区协作
- [多调用方扩展架构](docs/caller-integration-architecture.zh-CN.md) — Codex、Claude Code 与后续调用方共享 Runtime 和 Integration Pack 边界
- [延期路线图](docs/deferred-roadmap.zh-CN.md) — 明确暂缓的工作、启动条件与保留安全边界
- [验证指南](docs/validation.md) — 兼容性检查与人工验收流程
- [已知问题](KNOWN_ISSUES.md) — 当前升级与并发运行限制
- [贡献指南](CONTRIBUTING.md)与[安全说明](SECURITY.md)

## 许可证

[MIT](LICENSE)

Alpha 说明：DSH 仍处于 developer preview，本项目是独立社区项目，不代表 DeepSeek 或 OpenAI 官方背书。`0.1.0-alpha.1` 包含一个共享账本并发问题，已在 `0.1.0-alpha.2` 中修复。升级或并发运行 bridge 前请阅读[已知问题](KNOWN_ISSUES.md)。
