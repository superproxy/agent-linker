# AGENTS.md

本文件面向在本仓库工作的 AI 编码助手（CodeBuddy / Codex / Claude Code 等），只保留**上手必需**的信息；细节按主题拆到 `docs/`，见文末索引。

## 项目概览

LinkAgent Gateway —— OpenAI 兼容的本地 Agent 网关：

```
Chatbox / Open WebUI / 任意 OpenAI 客户端 ──▶ /v1 (OpenAI 兼容) ──▶ ACP(acpx) ──▶ 本机 agent
web 后台 (/ui, React)                        ──┘                   (opencode / pi / workbuddy /
个人微信 / 企业微信        ──▶ 渠道（插件运行时 or 独立 botAgent）──┘  trace-cli 等 ACP 类型)
```

- Node `>=22.13`，包管理固定 **pnpm@8.6.5**，ESM、TypeScript 严格模式，`tsx` 直跑源码。
- 网关 Fastify 5 + `ws` + `yaml`；前端 React 18 + Vite 5 + antd 5。
- pnpm monorepo：`backend/`（网关主体）、`shared/`（前后端共享类型/zod）、`web/`（管理后台）、`openclaw-shim/`。

## 快速上手

```bash
pnpm install
pnpm setup:pi                         # 可选：安装 pi / pi-acp 并生成 ~/.pi/agent 模型配置
pnpm dev                              # 网关开发，缺省 0.0.0.0:8787
pnpm typecheck                        # 全部包 tsc --noEmit
pnpm --filter @linkagent/backend test # 后端测试（基线 190 passed）
pnpm --filter @linkagent/web build    # 前端构建
```

## 必须遵守的约定

- **严格 TS**：数组/Map 取值视为可能 `undefined`，不用非空断言；相对导入带 `.js` 后缀；类型导入用 `import type`。
- **单向分层**：`api → service → store`；共享契约放 `shared/src`，不重复定义；持久化复用 `gateway/store/` KV，不新造裸文件读写。
- **鉴权**统一走 `users/auth.ts` 的 `AuthGuard`，不在 handler 内另判凭据；新增凭据类型需同步 auth/me、store/api、shared、测试（凭据分级见 `docs/architecture.md`）。
- 错误用 `openaiError(...)`（/v1）或 `errBody(...)`（管理接口）；密码 scrypt 加盐，不提交明文密钥。
- `.runtime-state/`、`backend/config/config.yaml` 不入库；`.codebuddy/` 是项目数据目录，**不要删除**。
- **新增功能必须补测试**，重构后保持全量通过。

## 工作方式偏好

每接到一个问题，**先解释清楚，再给出方案，然后再改代码**；不要一上来就问一串澄清，也不要未说明原因就动手。

1. **解释**：当前行为是什么、根因是什么（用仓库里的实际路径/调用，不要空泛猜测）。
2. **方案**：改什么、不改什么、影响范围；方案未说清前不写代码。
3. **操作**：用户已要求直接改、或方案已经讲清需要落地时，再做最小改动。
4. 涉及功能 / 界面时，方案里写清思路、改动点、影响范围；简单 bug 且原因已在第 1 步说清的可以直接改。
5. 做最小、聚焦的改动，不顺手大重构无关文件；提交信息与文档用简体中文。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/features.md`](docs/features.md) | 产品功能特性总览（/v1、按机器路由、节点审批、微信渠道、后台、鉴权、运维） |
| [`docs/architecture.md`](docs/architecture.md) | monorepo 结构、后端分层、鉴权与凭据模型 |
| [`docs/faq.md`](docs/faq.md) | 常用命令、测试方法、TS/ESM 坑、错误与密钥处理、已知遗留 |
| [`docs/design.md`](docs/design.md) / [`docs/deployment.md`](docs/deployment.md) | 设计记录 / 部署说明 |
| [`docs/pi.md`](docs/pi.md) | Pi 模型模板、云机自装、`pi-sandbox`（无 Docker）与缺 `rg`/`socat` 排障 |
| [`skills/linkagent-tasks/SKILL.md`](skills/linkagent-tasks/SKILL.md) | 默认任务任务管理 skill：启动 pi 注入 `LINKAGENT_*`（`pat_`），创建/列出/切换任务 |
