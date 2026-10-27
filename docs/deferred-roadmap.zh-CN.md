# 延期路线图

[English](deferred-roadmap.md) | **简体中文**

## 已实现

共享 Runtime 提供 Codex 编排、保留的 Claude Code legacy 安装器、委派与 follow-up、持久状态观察、类型化交互和协作 workspace claim。官方 Desktop Gateway 增加 Win/Mac 认证发现与用户控制的内存授权交接。

模型及 effort 跟随会话目录，账号/API Key provider 保持分离。Session 复用分为 `same-known-task`、`attached-existing-task`、`new-session`。跨对话接续依赖精确 canonical `cwd`、`mappedOnly`、`idleOnly` 及新鲜接管前置条件，标题或相似度不能决定选择。Compact handoff 携带调用方摘要，不会自动取得对话访问权。

复用能减少重复读取，也可能增加保留上下文的输入量。没有文档化聚合 cached-token 遥测时，保持 `providerCacheEvidence=not_exposed`。

[验证记录](validation.md)包含已完成的 Windows、Apple Silicon Mac 只读任务与同会话 follow-up，以及源码 CI、CodeQL 和作者策略证据。真实 rc.3 产品、Intel Mac 及扩展视觉/交互测试仍需单独安排。

## 暂缓项目

| 项目 | 启动条件 |
| --- | --- |
| 扩展真实交互验收 | 批准一次性 attachment、路由 follow-up、问题/取消/审批测试，并接受可能的全局模型默认值变化。使用正常交互，不人为制造 sandbox escape。 |
| Agent Preset 发现 | Host 提供稳定只读 roster、trust/broken 状态和能力/实际 preset 解析契约。 |
| 声明式 Session Launch Profile | 真实插件需要超出 `agentPreset` 的初始化，再设计类型化操作白名单及后置条件，不加入第三方可执行 hook。 |
| 常驻 coordinator / ACP / 跨调用方转交 | 出现明确外部 Agent 或多进程需求后，设计认证、发现、升级和状态归属。它与已经实现的官方 Host Gateway adapter 分开。 |
| 新调用方 | 恢复扩展时先验证 ZCode，再逐个评估 OpenCode、Workbuddy、Claude Desktop 等 Integration Pack。 |
| 结构化 handoff 字段 | 实测表明 compact prompt 不足。已知图片大小、尺寸和降采样状态已有文本通道，新增类型化 `imageAssets` 需有实际收益。 |
| 路由/coordinator 重构 | 公共行为稳定后，抽取 delegate/follow-up 共同事务并拆分 BridgeService，保留 schema 与 mutation 语义。 |
| 跨文件崩溃恢复 | 实际出现 mapping/claim 崩溃残留，或批准状态格式迁移后，再引入 journal 或合并记录。普通异常恢复已实现。 |
| ModLens 韧性与数据出域 | 先选上游贡献或 fork，再批准 timeout 透传、结构化 `nextSteps`、保真度/降采样取舍及第二 provider 的凭据、成本与数据策略。 |
| Gateway 能力缺口 | Host 提供可信 wire 契约后，再做图片模态发现、定时问题所有权或 subagent-mode 发现。仅有 provider callback 源码还不够。 |

更换电脑、运行时或依赖后，重新执行相关可移植性与验收检查。发布前审阅最终文件树和历史；现有 Win/Mac 证据适用于记录中的实测版本与环境。

## 运行边界

DSH 安装、应用生命周期、登录、profile 与网络设置由操作方管理。权限提升由人工批准，对话正文留在 DSH；启动授权只通过明确的私有进程交接传递。

通用 provider failover、自动图片预处理、旧对话正文语义搜索及仅凭相似措辞复用继续暂缓。npm 分发和原生 DSH bundle 打包另行决策。
