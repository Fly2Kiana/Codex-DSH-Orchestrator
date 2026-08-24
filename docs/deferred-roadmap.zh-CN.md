# 延期路线图

[English](deferred-roadmap.md) | **简体中文**

本文记录经过明确决策而暂缓的工作，便于未来开发会话恢复当前边界；这些内容不是已交付能力，也不是发布承诺。下列项目都不是当前 Codex → dsh-Agentlink → DSH Desktop 协作链路的必需条件。

## 当前已实现基线

- Codex 与 Claude Code 共用一套 connect-only MCP Runtime。
- Windows DSH Desktop loopback 自动发现已验证；不扫描端口，也不接管 Host 生命周期。
- 支持新建委派、已知任务 follow-up、有界观察、取消、类型化问题和人工把关审批。
- 支持 catalog 校验后的 `flash`、`pro`、`modlens-flash`、`modlens-pro` 及模型声明的 reasoning effort；省略路由时继承 DSH 当前 route。
- 支持仅元数据发现，并以新鲜的 id/update/cwd/title 前置条件显式接管一个精确、空闲的 root DSH session。
- 通过 MCP initialization instructions 与工具说明引导调用方生成 compact handoff；Agentlink 本身不会读取调用方聊天或工作区文件。

## 已实现的跨任务复用与成本边界

- 跨 Codex 任务的 session 复用已经实现并验收：新调用方可以使用带精确 canonical `cwd`、`mappedOnly`、`idleOnly` 的仅元数据 `dsh_find_sessions`，只有在找到唯一 mapped、idle root 且具备新鲜 `sessionId`/`updatedAt`/`cwd`/title 前置条件时，才可接管并对同一 root 执行 `dsh_followup`。
- orchestrator Skill 提供 `same-known-task`、`attached-existing-task`、`new-session` 三路决策；不会按标题或相似度选择，不会为发现读取历史，也不会猜测有歧义的候选。
- session 复用和避免重复扫描与 provider cache 证据分开报告；除非 Host 提供文档化的聚合 cached-token telemetry，否则默认保持 `providerCacheEvidence=not_exposed`。
- 本功能仍明确延期的 gate 只有跨工作树/新机器 portability hardening 与 release-surface revalidation；需遵循 [`docs/validation.md`](validation.md) 中的用户审批触发条件，不宣称 portability 或 provider cache 的永久收益。

## 延期方向及启动条件

1. **真实 Desktop 状态变更验收**
   - 暂缓内容：在一次性状态中重复验证真实 delegation、attachment、routed follow-up、question、cancel 与 approval。
   - 启动条件：操作方明确批准一次性 session/workspace，并接受 DSH 全局模型默认值可能变化的副作用。不得为了测试审批而故意制造 sandbox escape。

2. **Agent Preset 发现与能力预检**
   - 暂缓内容：只读 preset roster、trust/broken 状态、必需能力与实际解析 preset 报告。
   - 启动条件：Host 提供稳定、可能力探测且无需改写用户 profile 的 roster/resolution 契约。

3. **声明式 Session Launch Profile**
   - 暂缓内容：共享 backend pipeline 中类型化、白名单化的创建后初始化操作与 postcondition。
   - 启动条件：真实验证的插件无法只靠 `agentPreset` 选择支持。不得加入第三方可执行 launch hook 或插件私有 Runtime。

4. **Gateway、ACP 与跨调用方 task 可见性**
   - 暂缓内容：常驻 Agentlink Gateway、ACP frontend，以及显式跨调用方 task 发现/转交。
   - 启动条件：出现一级外部 Agent 或多进程拓扑需求，并先完成 loopback 绑定、认证、发现、升级和状态所有权设计。

5. **其他调用方 Integration Pack**
   - 暂缓内容：ZCode、OpenCode、Workbuddy、Claude Desktop MCP 等调用方专用 setup/verification pack。
   - 启动条件：逐个验证真实配置、权限、重载和 MCP 行为符合共享 Integration Pack 契约。

6. **更强的结构化 handoff 传输**
   - 暂缓内容：在现有 compact prompt 流程之上的类型化 handoff 对象或更丰富的调用方侧摘要。
   - 已知的图片字节大小、像素尺寸以及转换/降采样状态，可以作为可选文本写入 compact prompt，而无需修改 MCP schema。只有实测证明这种紧凑传输不足时，才启动类型化 `imageAssets` 字段。Agentlink 不得因此自动取得调用方聊天、秘密、原始大 diff 或无关文件正文。

7. **内部路由与 coordinator 重构**
   - 暂缓内容：抽取 delegate/follow-up 重复的模型选择事务，并拆分较大的 BridgeService orchestration surface。
   - 启动条件：公共行为稳定后作为维护工作执行；必须保留 MCP schema、fail-closed 路由与 mutation 不自动重试语义。

8. **接管状态的跨文件硬崩溃恢复**
   - 暂缓内容：通过 journal 或合并持久记录，reconcile 进程/机器在 task mapping 与 workspace claim 两个独立文件写入之间崩溃留下的状态。
   - 启动条件：实际观察到 crash residue，或批准状态格式迁移。当前事务会处理普通 claim 拒绝与运行时异常，但不宣称跨两个文件的文件系统事务语义。

9. **ModLens provider 韧性与数据出域策略**
   - 暂缓内容：上游 timeout 透传与结构化 timeout `nextSteps`、基于证据的图片降采样/重试，以及可选的第二视觉 provider failover route。
   - 启动条件：先决定向上游贡献还是维护本地 fork，并由操作方批准 provider 凭据、成本、数据出域、图片保真度取舍和一次性验收测试。Agentlink 不得自动改写 profile、认证、provider route、代理、DNS 或其他网络设置。

## 仍不在范围内

- 启动、关闭、重启、安装或重新配置 DSH Desktop/Web Host。
- 自动安装 DSH 插件或迁移认证/profile。
- 自动 provider failover、图片预处理/重试，或 DSH profile/网络变更。
- 对旧 DSH 对话正文做语义匹配，或仅因措辞相似就自动复用。
- 任意 provider/model 字符串、自动批准、凭据传输或在 bridge 中持久化对话正文。
- 未经单独发布与安全决策的 npm 发布或原生 DSH bundle。
