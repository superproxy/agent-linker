# AGENTS.md

本文件面向在本仓库工作的 AI 编码助手（CodeBuddy / Codex / Claude Code 等），说明项目结构、常用命令与必须遵守的约定。

## 1. 项目概览

LinkAgent Gateway —— OpenAI 兼容的本地 Agent 网关：

```
Chatbox / Open WebUI / 任意 OpenAI 客户端 ──▶ /v1 (OpenAI 兼容) ──▶ ACP(acpx) ──▶ 本机 agent
内置控制台 (GET /)        ──┘                                      (opencode / pi / workbuddy /
web 后台 (/ui, React)     ──┘                                       trace-cli 等 ACP 类型)
个人微信 / 企业微信        ──▶ 渠道（插件运行时 or 独立 botAgent）──┘
```

- 运行时：Node `>=22.13`，包管理固定 **pnpm@8.6.5**（见根 `packageManager`），ESM（`"type": "module"`）。
- 语言：TypeScript 严格模式，`tsx` 直接运行源码（无独立编译步骤）。
- 网关框架：Fastify 5；实时：`ws`；配置：`yaml`；前端：React 18 + Vite 5 + antd 5。

## 2. 工作区结构（pnpm monorepo）

`pnpm-workspace.yaml` 包含 4 个包：

| 包 | 路径 | 职责 |
|---|---|---|
| `@linkagent/backend` | `backend/` | 网关主体：`/v1` OpenAI 端点、`/api/*` 管理接口、渠道 bot、节点连接器、进程守护 |
| `@linkagent/shared` | `shared/` | 前后端共享类型与 zod 配置（`config.ts`/`openai.ts`/`user.ts`/`adapter.ts`/`node.ts`） |
| `@linkagent/web` | `web/` | React 管理后台，Vite 构建为静态文件，由网关同源挂到 `/ui` |
| `openclaw-shim` | `openclaw-shim/` | openclaw 工作区垫片（pnpm override `openclaw: workspace:*`） |

后端源码 `backend/src/`：

- `gateway/` —— 网关核心。`index.ts`（Fastify 装配 + `/v1` handler）、`config.ts`；子目录：
  - `agents/` agent/ACP 引擎管理；`nodes/` 节点注册与审批；`tasks/` 多任务路由（api→service→store）；
  - `users/` 登录账号、会话、`AuthGuard`、渠道用户凭据（`ct_`）、个人 API token（`pat_`）；
  - `plugins/` 渠道插件运行时；`pm/` 进程管理；`prefs/` 用户偏好；`store/` 通用 KV（原子写/损坏隔离）。
- `channels/` —— 独立 botAgent：`weixin-bot.ts`、`wecom-bot.ts`。
- `node/connector.ts` —— 节点连接器（WebSocket 接入网关）。
- `supervisor/` —— 多进程守护（`cli.ts` 提供 `pm:*` 命令）。
- `install/` —— 安装/布局；`dev/` —— 探针与冒烟脚本（probe / smoke-plugin 等）。

测试与源码同构：`backend/test/<模块>/*.test.ts`。

## 3. 常用命令

在仓库根目录执行：

```bash
pnpm install
pnpm dev            # 网关开发（tsx watch，改代码自动重启），缺省 0.0.0.0:8787
pnpm start          # 前台运行
pnpm typecheck      # 对所有 workspace 包跑 tsc --noEmit
pnpm build:web      # 构建 web 后台（tsc --noEmit && vite build）
pnpm web            # web 以 build --watch 自动重建

# 测试（在 backend/ 下，或 pnpm --filter @linkagent/backend test）
pnpm --filter @linkagent/backend test
```

后端独立命令（`pnpm --filter @linkagent/backend <script>`）：

- `typecheck`：`tsc --noEmit`
- `test` / `test:watch`：node 内置 test runner（`tsx --test`），按目录 glob 组织
- `bot:weixin` / `bot:wecom`：独立渠道 bot
- `pm`（`start/stop/restart/status/logs/fg`）：进程守护
- `probe` / `smoke-plugin` / `weixin-login`：`src/dev/` 下的排障脚本

服务/节点运维脚本：根 `pnpm server:*` 与 `pnpm node:*`（封装 `scripts/server.sh`、`scripts/node.sh`）。

## 4. 代码约定（必须遵守）

- **严格 TS**：`strict: true` + `noUncheckedIndexedAccess: true`。数组/Map 取值按可能为 `undefined` 处理；不要用非空断言绕过。
- **ESM + NodeNext**：相对导入必须带 `.js` 扩展名（即使源文件是 `.ts`），例如 `import { x } from './auth.js'`。
- `verbatimModuleSyntax: true`：类型导入一律用 `import type { ... }`。
- 前后端共享的契约类型放 `shared/src`，经 `@linkagent/shared` 引用，**不要**在两端各自重复定义。
- 持久化优先复用 `gateway/store/` 的通用 KV（JSON 原子写、损坏隔离），落盘到 `.runtime-state/`；不要新造裸文件读写。
- 分层依赖方向保持单向：`api → service → store`；鉴权统一走 `users/auth.ts` 的 `AuthGuard`，不要在 handler 内另写凭据判断。
- 错误返回遵循网关既有结构（OpenAI 端点用 `openaiError(...)`，管理接口用 `errBody(...)`）。
- 不提交明文密钥；密码用 scrypt + 随机 salt 哈希（见 `users/store.ts`）。
- `.runtime-state/`、`backend/config/config.yaml` 等本地运行态不入库；`.codebuddy/` 是项目数据目录，**不要删除**。

## 5. 测试要求

- **新增功能必须补测试**，重构后必须保持全量测试通过（当前基线 **189 passed**）。
- 测试框架是 node 内置 `node:test` + `node:assert/strict`，用 `app.inject(...)` 做接口级测试，临时目录用 `mkdtempSync`。
- 改动后至少跑：
  ```bash
  pnpm --filter @linkagent/backend typecheck
  pnpm --filter @linkagent/backend test
  ```
  涉及前端再跑 `pnpm --filter @linkagent/web build`。

## 6. 鉴权与凭据模型（改动时务必对齐）

`AuthGuard.resolve` 产出的凭据态：`disabled | token | local | session | personal | channelUser | none`；`resolveChat` 额外识别 `task`。

- 静态 token（`auth.token`）：管理员级机器凭据；`local` 模式下回环无凭据映射为本机默认用户。
- 会话 token：浏览器登录。
- **个人 API token（`pat_` 前缀）**：一个登录账号一枚长期 token，自助 4 接口 `GET/POST ensure/POST rotate/DELETE /api/personal-tokens`，语义等同账号本人（在 `checkAuth/sessionUser/isAuth/isAdmin` 与 `/api/auth/me` 中与 `session` 同等放行）。
- **渠道用户 token（`ct_` 前缀）**：作用域凭据，仅代表其 `channel/userId`，只能访问 `/v1` 与自己的资源，不放行管理接口。
- 任务 key（`k_`）：仅 `resolveChat` 识别并锁定任务，不能用于管理接口。

新增凭据类型时，需同时更新：`auth.ts`（解析 + 三个守卫）、`/api/auth/me`、对应 store/api、shared 类型与测试。

## 7. 工作方式偏好

- 涉及**功能开发 / 界面改动**时，先给出设计方案（思路、改动点、影响范围），经确认后再写代码；简单 bug 修复或明确说"直接改"除外。
- 优先做最小、聚焦的改动；不要顺手大重构无关文件。
- 提交信息与文档使用简体中文。

## 8. 已知遗留

- `web/src/pages/`（含 `MyToken.tsx`、`constants.ts` 等）是**未被引用的 antd 重构残留**：实际渲染的是 `web/src/App.tsx` 内联组件。`constants.ts` 在 `.ts` 文件中写 JSX，导致 `pnpm --filter @linkagent/web build` 的 `tsc` 报 TS1005。修复方向：删除该残留目录，或将 `constants.ts` 改为 `.tsx`。
- 个人 token（`pat_`）后端与文档已完成；界面侧遗留：回归验证「我的 Token」交互、修复 web 构建、`pat_` 经 Chatbox 直连 `/v1` 的端到端联调。
