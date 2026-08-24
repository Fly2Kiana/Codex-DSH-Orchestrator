# Codex-DSH-Orchestrator 项目概览

[English](project-overview.md) | **简体中文**

Codex-DSH-Orchestrator 是一个以 Codex 为主要入口的编排层和调用方 MCP bridge，用于与官方 DeepSeek Harness（DSH）Web Host 进行有边界的协作。

## 本项目负责什么

本项目负责 Codex 一侧的编排体验、调用方 handoff 指引、任务监督、会话继续决策，以及本派生项目中持续维护的共享 bridge/runtime。最终决策、审批边界和独立验收仍由主调用方保留。

本仓库不会启动、停止、守护或拥有 DSH Web Host；它不是身份认证边界，不会自动批准 DSH 请求，也不是 DSH Cordis bundle。

## 组件关系

~~~text
Codex-DSH-Orchestrator
├── skill/codex-dsh-orchestrator/
│   └── Codex-first 编排 skill 与 agent 元数据
├── skill/codex-dsh/
│   └── 共享的 Codex 调用方兼容 skill
├── skill/claude-code-dsh/
│   └── 保留的 Claude Code 调用方兼容 skill
├── src/
│   └── 共享的、与调用方无关的 MCP bridge runtime 与配置工具
├── test/
│   └── 本地 mock Host、安全、兼容性和集成测试
└── docs/
    └── 架构、验证、路线图和维护说明
~~~

## 与 dsh-Agentlink 的关系

共享 bridge runtime 是基于 [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) 独立维护的派生组件。原始 MIT 许可证、版权声明和上游归属保留在 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE) 中。本源代码版本继续保留与 dsh-Agentlink 兼容的运行时包名、CLI 名称和 MCP 标识。

Codex-DSH-Orchestrator 独立于 DeepSeek、OpenAI 和上游维护者。DSH 仍是由用户独立管理的 Host 与服务。

## 调用方支持

- Codex 是主要支持的调用方，使用 skill/codex-dsh-orchestrator/ 和共享 bridge。
- Claude Code 通过保留的调用方集成包获得支持。
- ZCode、OpenCode、Workbuddy 和其他调用方会在其宿主行为与安全边界得到验证后再适配。

## 安全边界

bridge 采用 connect-only 模式。对话内容仍保存在 DSH session history 中；bridge 只持久化协作状态与内容指针。审批响应始终需要人工控制，workspace claim 只协调合作的 bridge 进程，不声称能够强制 DSH Host 的 sandbox。

## 分发状态

初始分发形式是 GitHub 源码快照。package.json 继续保持 private: true；npm 发布是未来独立决策，不属于本次源码发布。
