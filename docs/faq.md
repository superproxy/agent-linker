# FAQ：命令、测试与常见问题

> 面向在本仓库工作的 AI 助手与开发者。功能见 `docs/features.md`，结构/鉴权见 `docs/architecture.md`。

## 常用命令

在仓库根目录执行：

```bash
pnpm install
pnpm setup:channels # 校验企微/飞书 OpenClaw 插件（backend 已声明依赖；channel-gateway 前建议跑一次）
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

## 怎么跑测试

- **新增功能必须补测试**，重构后必须保持全量测试通过（当前基线 **190 passed**）。
- 测试框架是 node 内置 `node:test` + `node:assert/strict`，用 `app.inject(...)` 做接口级测试，临时目录用 `mkdtempSync`。
- 改动后至少跑：

  ```bash
  pnpm --filter @linkagent/backend typecheck
  pnpm --filter @linkagent/backend test
  ```

  涉及前端再跑 `pnpm --filter @linkagent/web build`。

## TypeScript / ESM 有哪些坑

- **严格 TS**：`strict: true` + `noUncheckedIndexedAccess: true`。数组/Map 取值按可能为 `undefined` 处理；不要用非空断言绕过。
- **ESM + NodeNext**：相对导入必须带 `.js` 扩展名（即使源文件是 `.ts`），例如 `import { x } from './auth.js'`。
- `verbatimModuleSyntax: true`：类型导入一律用 `import type { ... }`。

## 错误返回与密钥怎么处理

- 错误返回遵循网关既有结构（OpenAI 端点用 `openaiError(...)`，管理接口用 `errBody(...)`）。
- 不提交明文密钥；密码用 scrypt + 随机 salt 哈希（见 `users/store.ts`）。
- `.runtime-state/`、`backend/config/*.yaml`（含 `gateway.yaml` / `weixin.yaml` / `node.yaml` / `config.yaml`）等本地配置不入库；`.codebuddy/` 是项目数据目录，**不要删除**。

## Pi 安装与模型配置

云机/新机（**执行机**）：`pnpm setup:pi` 或独立节点包 `npm run setup:pi`（安装 pi CLI、`pi-acp@0.0.33`，生成 `~/.pi/agent/models.json`）。网关不必装 pi-acp。说明见 [`docs/pi.md`](pi.md)。

## Pi 沙箱报缺 ripgrep / socat

`Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found, socat not installed` 是 **跑 pi 的 Linux 机** 缺系统包，不是网关 yaml。装 `ripgrep` `socat` `bubblewrap`，完整步骤见 [`docs/pi.md`](pi.md)。Windows 本机不要装 `pi-sandbox`。

## 已知遗留 / 待办

- 个人 token（`pat_`）后端、接口与「我的 Token」界面已完成；遗留 `pat_` 经 Chatbox 等第三方客户端直连 `/v1` 的端到端回归联调。
- 网关运行时配置：当前默认 `json-overlay`（`.runtime-state/gateway/overlay.json`）；`LINKAGENT_RUNTIME_STORE=sqlite` 与 `gateway/store/runtime/sqlite-repository.ts` 已预留接口与 schema 注释，**尚未实现**，后续与其它运行态统一入库时再补。
- Agent 管理已按机器（节点）分组（本机可编辑、远程只读）；节点连接器侧的开通项仍需在各机器本地用 `LINKAGENT_NODE_AGENTS` 维护，后台暂无远程下发能力（产品上刻意只读）。
