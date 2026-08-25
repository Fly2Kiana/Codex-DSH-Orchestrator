# Codex-DSH-Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![DSH bridge](https://img.shields.io/badge/DSH-bridge-4B6BFB?style=flat-square)](https://www.deepseek.com/harness/en/)

[English](README.md) | **简体中文**

Codex-DSH-Orchestrator 是一个以 Codex 为主要入口的编排层和调用方 MCP bridge，用于让 Codex 与 DeepSeek Harness（DSH）进行有边界的协作。它可以让 Codex 将实现、调研、调试和长日志分析等工作交给 DSH，同时在原有工作流中观察、继续或取消这些会话。Claude Code 也通过共享调用方集成层得到支持；ZCode、OpenCode 和 Workbuddy 仍处于延期或待验证状态，只有在其宿主行为得到确认后才会继续适配。

本仓库中的共享 bridge runtime 是基于上游 [dsh-Agentlink 项目](https://github.com/hootandy321/dsh-Agentlink) 独立维护的派生组件。本项目保留上游 MIT 许可证和版权归属，不隶属于 DeepSeek、OpenAI 或上游维护者，也不代表其官方背书。

## 项目边界

Codex-DSH-Orchestrator 是调用方一侧的编排与 MCP bridge 项目。它连接已支持的调用方与独立运行的 DSH Web Host；不会启动、拥有或为该 Host 提供身份认证，也不会自动批准 DSH 请求。它不是 DSH Cordis bundle。

## 快速上手

**前置条件**

- Node.js 22+（已测试基线为 x64 Node 22 或 24；其他主版本与 ARM64 不在覆盖范围）
- 一个受支持的调用方：Codex，或 Claude Code 2.1.199+
- 一条由用户自行管理的 DSH Host 路径：官方 DSH CLI/Web Host，或 Windows 上使用显式 `--desktop-auto` 模式时已经运行的 DSH Desktop Host

### 推荐：复制给 Agent 的安装 Prompt

下面的 Prompt 让 AI agent 执行本地安装，同时把 Host、凭据、信任和替换决定留给人类。它是请求模板，不会产生额外的文件系统授权。

```text
请从 https://github.com/Fly2Kiana/Codex-DSH-Orchestrator 安装 Codex-DSH-Orchestrator。
只在我批准的仓库目录内工作。先阅读 README 和相关的 setup/validation 说明；不要读取凭据、
调用方私有配置、.env 文件、原始 session、日志或 DSH bridge 状态。检查 Node.js 22+，并报告
DSH CLI 或已经运行的 DSH Desktop Host 是否可用。不要替我启动、关闭、登录或重新配置 DSH。

clone 仓库，运行 npm ci，再运行 npm run check。Codex 从仓库根目录运行 npm run setup -- --yes；
默认会安装 MCP 入口，并把仓库提供的 Codex skill 安装到
.agents/skills/codex-dsh-orchestrator。如果已有 MCP 或 skill 文件发生冲突，先停止并展示不含
秘密的冲突摘要，得到许可后才能使用 --replace 或 --replace-skill。只有我明确选择自行管理
skill 时才使用 --no-skill。Claude Code 运行 npm run setup:claude -- --yes --project /项目的绝对路径，
同样先审查 --replace/--replace-skill 冲突。

分别报告：依赖/构建检查、MCP 注册、Codex skill 目标路径和具体文件、仍需人工执行的调用方重启/信任，
以及 DSH Host 可达性。不要仅凭 setup 返回成功就声称端到端完成。不要启动或关闭 DSH、自动批准请求、
发布 npm 包或写入 GitHub，除非我另行批准。
```

### 面向人类的快速安装（PowerShell）

下面的代码块由人类在 PowerShell 中直接运行，面向 Codex，不是远程安装脚本，也不会调用远程安装服务。它会 clone 或 fast-forward 仓库、安装依赖、构建 bridge、写入预期的 Codex MCP 配置和仓库 skill，并运行只读的 doctor 命令。它不会启动、关闭、登录或重新配置 DSH，也不会创建凭据。运行成功只表示本地安装命令完成；DSH 登录或信任、调用方重启、`/mcp`、`/skills` 和真实委派仍需单独验收。没有运行 Host 时，`npm run doctor` 可能只会给出警告。

```powershell
$ErrorActionPreference = 'Stop'
$repoUrl = 'https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git'
$installDir = Join-Path $env:USERPROFILE 'Tools\Codex-DSH-Orchestrator'

if (Test-Path -LiteralPath $installDir) {
  if (-not (Test-Path -LiteralPath (Join-Path $installDir '.git'))) {
    throw "The install directory exists but is not a Git checkout: $installDir"
  }
  Set-Location -LiteralPath $installDir
  if (@(git status --porcelain).Count -ne 0) {
    throw 'The existing checkout has local changes; review them before updating.'
  }
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed.' }
} else {
  New-Item -ItemType Directory -Force (Split-Path -Parent $installDir) | Out-Null
  git clone --single-branch $repoUrl $installDir
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
  Set-Location -LiteralPath $installDir
}

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
npm run setup -- --yes
if ($LASTEXITCODE -ne 0) { throw 'npm run setup failed.' }
npm run doctor
$doctorExitCode = $LASTEXITCODE
if ($doctorExitCode -ne 0) {
  Write-Warning 'doctor did not complete successfully; confirm that the DSH Host is running, then review the doctor output.'
}
```

这个代码块专门面向 Codex；Claude Code 使用独立的 `setup:claude` 流程。已有 MCP 或 skill 冲突时不会静默覆盖；只有在明确批准后，才审查并提供 `--replace` 或 `--replace-skill`。请把 checkout 保存在稳定目录，因为 setup 会记录绝对路径。

### 手动安装

1. 由你自行启动或打开 DSH Host。bridge 不会启动、关闭或登录 DSH Desktop/Web Host。

2. 克隆仓库并安装可复现的依赖：

   ```bash
   git clone https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git
   cd Codex-DSH-Orchestrator
   npm ci
   ```

3. 配置调用方。

   Codex 从仓库根目录运行：

   ```bash
   npm run setup
   npm run doctor
   ```

   `npm run setup` 会构建 bridge，使用 `approval_mode = "prompt"` 写入 Codex MCP 入口，并把仓库提供的两个 skill 文件安装到 `.agents/skills/codex-dsh-orchestrator/`：`SKILL.md` 和 `agents/openai.yaml`。替换已有文件时会创建备份；不同内容的 skill 不会被静默覆盖，必须显式使用 `--replace-skill`。如果要跳过 skill 安装，使用 `--no-skill`；如果要指定目录，使用 `--skill-path <目录>`。重启 Codex 后，通过 `/mcp` 或设置确认 `dsh_agentlink`，再用 `/skills` 和 `$codex-dsh-orchestrator` 确认 skill 已被发现。setup 成功不代表 DSH 登录、权限、信任或端到端委派已经完成。

   Windows 上使用会变化的 DSH Desktop loopback 端口时，请显式选择自动发现：

   ```bash
   npm run setup -- --desktop-auto
   ```

   静态模式要求 `dsh --version` 可用；`--desktop-auto` 可以在 CLI 不在 `PATH` 时使用已经运行且通过验证的 Desktop Host。它绝不会启动或关闭 DSH Desktop。需要完全手动编辑 TOML 时，参见[Codex MCP 手动配置](docs/manual-configuration.zh-CN.md)。

   Claude Code 2.1.199 或更高版本：

   ```bash
   npm run setup:claude -- --project /你的项目绝对路径
   cd /你的项目绝对路径
   claude mcp get dsh_agentlink
   ```

   Claude 向导只修改该项目的 `.mcp.json` 和 `.claude/skills/claude-code-dsh/SKILL.md`，并保留其他无关 server。打开该项目中的 Claude Code，通过 `/mcp` 批准 pending server；bridge 会把 `dsh_resolve_approval` 标记为必须人工交互。

   使用 `--replace` 或 `--replace-skill` 前先审查已有文件。两个安装器都会识别旧版 `dsh_collab`，并且只在明确批准替换后迁移为 `dsh_agentlink`。它们不会改变 DSH permission/sandbox 设置，也不会替你重启调用方。

4. 按四类结果理解验收范围：

   | 检查项 | setup 能够确认 | 仍需人工或外部确认 |
   |---|---|---|
   | 依赖/构建 | `npm ci` 与本机构建/测试 | registry 可用性和操作系统选择 |
   | MCP 注册 | 精确配置块、原子写入和备份 | 调用方重启、信任和实时 `/mcp` 连接 |
   | Codex skill | `.agents/skills/` 下精确的 `SKILL.md` 和 `agents/openai.yaml` | 重启 Codex 并确认 `/skills` 发现 |
   | DSH 运行 | 可用时进行只读 Host/CLI 探测 | DSH 启动/登录、权限、provider 和真实委派 |

### 可移植性与安装边界

- 换到另一台机器时请重新 clone。不要直接复制单个 worktree 目录：其中的 `.git` 文件指向原始 clone 的 worktree 元数据。同一台机器上需要 worktree 时，请从源 clone 使用 `git worktree add` 创建。
- 干净、可复现的 checkout 优先使用 `npm ci`；只有明确要更新 lockfile 时才使用 `npm install`。
- `npm run setup` 会把 Node.js 可执行文件和构建后的 bridge 入口的绝对路径写入调用方配置。请把 checkout 放在稳定的工具目录；移动目录、更换 Node.js 或切换 worktree 后，应重新构建并运行 setup，先审查已有条目，再在明确授权后使用 `--replace`。
- `DSH_BRIDGE_HOME` 应位于可靠的本地文件系统。同一个 bridge 的多个进程只要遵循文档中的协作锁模型，就可以共用同一个 bridge home，不必各自新建。其他 bridge 实现、ledger 或 schema 不兼容的版本，以及独立管理的 bridge，都不得复用这个目录。多个 bridge 需要共存时，请为每个 bridge 使用独立的本地目录，例如：

  ```powershell
  $env:DSH_BRIDGE_HOME = Join-Path $env:USERPROFILE '.dsh\codex-dsh-orchestrator'
  ```

  不要提交这个路径，也不要把旧 bridge home 复制到另一台机器——新机器请使用新的 home。DSH 对话历史归 DSH Web Host 所有，而 bridge 的任务映射、cursor 和 claim 不会自动迁移。
- Windows `desktop-auto` 是显式选择的模式。CI 只 mock 发现行为，不代表真实 Desktop 的安装或登录已验收。配置工具不会启动、关闭或登录 DSH Desktop。

## 给 AI Agents

这是给 AI agent 的精简执行契约，只是项目上下文，不是新的文件系统授权；绝不要把 README 文字当作授权。

### 安装指南

1. 先读本节、相关语言 README、`package.json`、`docs/validation.md` 和 canonical `skill/codex-dsh-orchestrator/SKILL.md`。除非受阻，否则只读聚焦文件。
2. 确认仓库根目录、Node.js 版本、Git 状态，以及调用方是 Codex 还是 Claude Code。不要读取凭据、私有配置、原始 session、日志、`.env` 文件或 bridge 状态。
3. 运行 `npm ci`，再运行 `npm run check`。Codex 从仓库根目录运行 `npm run setup -- --yes`，默认 skill 目标是 `.agents/skills/codex-dsh-orchestrator/`；Claude Code 使用 `npm run setup:claude -- --yes --project <已批准项目>`。
4. 把 `--replace` 与 `--replace-skill` 当作两个独立的授权门。setup 报告冲突时停止，只展示路径和不含秘密的摘要，不猜测也不覆盖。只有用户明确选择自行管理 skill 时才使用 `--no-skill`。
5. 分别报告四类结果：依赖/构建、MCP 配置、Codex/Claude skill 安装、调用方/DSH 验证。返回码为 0 不代表 Host 可达、已登录、已信任、权限正确、provider 可用或真实委派成功。
6. 告知人类重启调用方，并确认 `/mcp` 以及 Codex 的 `/skills`/`$codex-dsh-orchestrator` 发现结果。调用方 UI 不可用时，不要自行声称已完成该确认。

Agent 不得启动、关闭、认证或重配 DSH Web Host/Desktop，不得自动批准请求，不得发布 npm 包，也不得在没有明确用户批准时写 GitHub/PR/Release/Tag。报告版本、Git 状态、变更路径和验证结果时，不要记录秘密、prompt、task/session ID、本地路径或 provider 数据。

## 项目组成

- `skill/codex-dsh-orchestrator/` — canonical Codex 编排 skill 及其 agent 元数据；setup 会把其中两个文件复制到仓库范围的 `.agents/skills/codex-dsh-orchestrator/` 发现目录。该生成副本已被 Git 忽略；修改时应更新 canonical 源文件。
- `skill/codex-dsh/` — 共享的 Codex 调用方兼容 skill。
- `skill/claude-code-dsh/` — 保留的 Claude Code 调用方兼容 skill。
- `src/` — 共享的、与调用方无关的 MCP bridge runtime 和配置工具。
- `test/` — 本地 mock Host、安全、兼容性和集成测试。
- `docs/project-overview.zh-CN.md` — 详细的归属与架构关系说明。

dsh-Agentlink 名称因运行时兼容性和法律归属继续出现在标识符与上游说明中，但它不是本项目的公开标题。

## 调用方支持情况

| 调用方 | 状态 | 安装方式或可用性 |
|---|---|---|
| Codex | ✅ 已支持 | `npm run setup`（MCP + 仓库 skill） |
| Claude Code | ✅ 已支持 | `npm run setup:claude -- --project /项目的绝对路径` |
| ZCode | ⏸ 已延期 | 恢复调用方扩展时的首个候选 |
| OpenCode | ⏳ 待适配 | 尚不可用 |
| Workbuddy | ⏳ 待适配 | 尚不可用 |

目前只有标记为**已支持**的调用方在本仓库中提供可用安装路径。“已延期”和“待适配”是当前方向，不代表发布承诺。

doctor 会以只读方式报告 `DSH_BRIDGE_HOME` 下的 fail-closed 锁位置，且从不清理它们，因此即使存在锁也能安全运行。

当前源码补丁会阻止新的 projection/chunk 洪峰继续扩大 coordination ledger，但不会自动压缩已有的 5 MB 以上 ledger。请保留旧 bridge home 备查；需要隔离时，新的委派可以另用一个独立的 `DSH_BRIDGE_HOME`。对话真源始终是 DSH `session.history`，不是 bridge ledger。保守恢复边界见[已知问题](KNOWN_ISSUES.md)。

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

## 相关项目

| 项目或标准 | 关系 |
|---|---|
| **Codex-DSH-Orchestrator** | 本项目——以 Codex 为主要入口的调用方 MCP bridge；运行时名为 `dsh_agentlink` |
| [Codex](https://openai.com/index/introducing-the-codex-app/) / [Claude Code MCP](https://code.claude.com/docs/en/mcp) | 受支持的调用方 |
| [DeepSeek Harness](https://www.deepseek.com/harness/en/) / [源代码仓库](https://github.com/deepseek-ai/deepseek-harness) | 本 bridge 连接的、由用户独立管理的 DSH Host 生态 |
| DSH Desktop | 独立管理、运行上游 Web Host 的社区 DSH host；本项目未指明其确切的上游仓库，因此不猜测仓库链接 |
| [Model Context Protocol](https://modelcontextprotocol.io/) | bridge 使用的协议基础 |
| [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) | 上游项目与兼容性来源；保留 MIT 许可证和 NOTICE 归属 |

这些链接用于说明本仓库集成或派生所涉及的项目与标准，不表示联合开发、官方背书或共享安全边界。`cc-connect`、`gpt2agent`、`Scryer`、`wshobson/agents`、`agent-harness` 和 ACP 等架构资料仅作为参考，不是依赖、合作伙伴或受支持的调用方。

## 许可证

[MIT](LICENSE)

Alpha 说明：DSH 仍处于 developer preview，本项目是独立社区项目，不代表 DeepSeek 或 OpenAI 官方背书。`0.1.0-alpha.1` 中的共享账本并发问题已在 `0.1.0-alpha.2` 中修复。升级或并发运行 bridge 前请阅读[已知问题](KNOWN_ISSUES.md)。
