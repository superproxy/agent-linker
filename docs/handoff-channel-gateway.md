# Channel-Gateway 交接说明（给其他智能体）

## Cursor 如何接管（新 Agent / 新对话）

1. **打开同一仓库**  
   工作区根目录为 `agent-linker`（与本文路径一致），Node ≥ 22.13、`pnpm@8.6.5`。

2. **第一条消息建议固定模板**（复制改日期/commit 即可）：

   ```text
   请按 docs/handoff-channel-gateway.md 接手 channel-gateway 相关工作。
   先读该文档和 AGENTS.md 开发流程，不要恢复 weixin:<用户> 多进程或 gateway 内嵌 weixin-bot。
   从 P0 文档一致性或 P0 测试基线开始；做完一项在 handoff 文档里勾选或更新状态。
   当前 git：git log -1 / git status（自行执行确认）。
   ```

3. **用 @ 引用减少幻觉**（Cursor 聊天里）  
   - `@docs/handoff-channel-gateway.md` — 待办与边界  
   - `@AGENTS.md` — 分层、鉴权、先方案后代码  
   - 动代码前再加：`@backend/src/supervisor/manager.ts`、`@backend/src/channels/channel-gateway.ts` 等（见下文索引）

4. **不要依赖旧对话**  
   其它 Cursor 窗口**看不到**本 chat 历史。以 **git + handoff 文档 + 代码** 为准；若需要上文决策，只看 handoff 里「背景 / 已完成 / 待办」。

5. **可选：延续同一 Cursor 项目**  
   - 同一 **Project** 下新 Chat 仍会加载 `.cursor/rules`、用户 Rules、`AGENTS.md` 规则。  
   - **Cloud Agent / 新机器**：clone 同一分支，确保包含 `docs/handoff-channel-gateway.md`（未 push 则先 push 或拷贝文件）。

6. **接手的标准动作（Agent 应自行执行）**

   ```bash
   git status && git log -3 --oneline
   pnpm install && pnpm setup:channels
   pnpm typecheck
   pnpm --filter @linkagent/backend test
   ```

7. **改库约定**  
   仓库规则要求：非 trivial 改动前先说明现状 / 流程 / 方案（见 `AGENTS.md`）。用户若说「按 handoff 直接做 P0-x」，视为已确认方案。

8. **并行多人 / 多 Agent**  
   避免同时改 `gateway/index.ts` + `channel-gateway.ts` + 大文档；按 handoff 的 P0→P1 拆 PR 或串行 commit，减少冲突。

---

本文档汇总 channel-gateway / 个人微信 / 企微相关**已完成项**与**待办**，便于接手时不重复劳动、也不按过时文档改错架构。

## 背景

- **基线提交**：`89fb78d` — 独立 `channels` 进程承载企微 / 飞书 / 个人微信，对话经 `/v1` SSE 回连主网关。
- **分支状态**（撰写时）：`main` 可能超前 `origin/main`；以 `git log -1` 为准。
- **个人微信两套实现（均在 `channels` 进程内，二选一或仅开 bot）**：

  | 方式 | 配置 | 说明 |
  |------|------|------|
  | **ilink 薄 adapter** | `channelGateway.weixin: true`，`weixinPlugin: false` | `weixin-bot.ts`，扫码仍用 OpenClaw 插件写登录态 |
  | **OpenClaw 插件收发** | `channelGateway.weixinPlugin: true` | 加载 `@tencent-weixin/openclaw-weixin` |

- **进程模型（当前代码，非旧文档）**：
  - 个人微信 **不再** gateway 内嵌 `weixin-bot`。
  - **不再** 为每登录用户起 `weixin:<用户名>` 独立进程；PM 统一 **`channels`**。
  - 扫码绑定 → overlay `weixin.accounts` + 写 `channels.yaml`（`persistEnsureWeixinAccount`）→ **`pm restart channels`**。

## 已完成（勿重复实现）

- [x] `backend/src/channels/channel-gateway.ts` — channels 入口（weixin-bot / 插件 / 企微 / 飞书）
- [x] 企微/飞书后台：`wecom-config-api.ts`、`feishu-config-api.ts`、`Wecom.tsx`、`Feishu.tsx`
- [x] 个人微信 channel-gateway 后台：`weixin-config-api.ts`、`persist-weixin.ts`、`Weixin.tsx` 管理员卡片
- [x] 绑定持久化：`persistEnsureWeixinAccount` → 启用 `channelGateway` + `weixin`
- [x] 插件账号运行态：`plugins/manager.ts`、`plugins/account-status.ts`
- [x] 派发追踪：`store/dispatch-trace.ts` + 埋点 + `web/.../channel-gateway-log-panel.tsx`
- [x] `pnpm setup:channels`、文档骨架：`docs/channels.md`、`docs/channel-gateway.md` 等

## 待办任务

### P0 — 文档与代码一致

`AGENTS.md` 与部分 `docs/`、`web/` 曾描述「每用户 `weixin:<username>` 进程 / gateway 内嵌微信」，与当前实现冲突（已对齐）。

- [x] 更新 **`AGENTS.md`** 个人微信小节：channel-gateway + `channels`、两种收发、绑定后 restart channels。
- [x] 同步 **`docs/features.md`**、**`docs/channels.md`**、**`docs/architecture.md`**：推荐路径仅为 channel-gateway；legacy 内嵌/多进程如有保留需单独标注 deprecated。
- [x] 更新 **`web/src/pages/Accounts.tsx`** 等仍写 `weixin:<用户名>` 的文案 → `channels`。
- [x] 更新 **`backend/src/gateway/pm/api.ts`**、**`backend/src/supervisor/cli.ts`** 注释：`weixin` / `weixin:<id>` 展开为 `channels` 的行为。

**验收**：仓库内检索 `weixin:<`、「内嵌 weixin-bot」「每账号独立进程」与 `supervisor/manager.ts` 行为一致。

### P0 — 验证与基线

- [x] `pnpm typecheck`
- [x] 重点：`test/supervisor/*.test.ts`、`test/gateway/weixin-config.test.ts`、`test/gateway/config.test.ts`
- [x] `pnpm --filter @linkagent/web build`
- [x] 旧单文件 fixture（`gateway.auth.yaml`）曾被 split 加载器忽略、落成 local 鉴权，导致任务 key / 匿名请求被当成管理员。已改为 `migrateConfig` 读取。`scope-credentials` / `rbac` / `local-auth` / `config` 通过。
- [ ] `pnpm --filter @linkagent/backend test` 全量：本机曾在 nodes 之后挂起（疑似残留子进程），与文档改动无关；接手可再跑一遍确认退出。

失败时修测试或实现，**不要**恢复 `weixin:*` 多进程模型。

### P1 — 企微无入站 / 无回执（现场问题）

- [x] 查 `.runtime-state/pm/logs/channels.log`：WS `Authentication successful` 只是长连接认证（插件会打两次）。业务消息是 `cmd=aibot_msg_callback`。
- [x] 单聊「你好」「/task list」已进入插件；`/task list` 回执时 `@wecom/wecom-openclaw-plugin` 的 `deliver(payload, info)` 读 `info.kind`，本仓库只传了 payload，进程 TypeError 退出，所以没有完整回执。
- [x] `reply.ts` 交付时带 `{ kind: 'block' }`。
- [x] trace 行同时 `console.log`，会进 pm 的 `channels.log`（原先只在内存环）。
- [ ] 重启 `channels` 后再发一条企微消息，确认 trace 含 `channels.inbound` → `channels.v1` → `channels.reply`，且进程不退出。

**验收**：一条企微消息后 trace 链含 `channels.inbound` → `/v1` → 回执相关 step。

### P1 — 个人微信产品化

- [ ] Admin 切换 `weixinPlugin` 时同步 overlay `weixin.mode`（`openclaw-weixin-plugin` vs `external`）
- [ ] **插件微信多账号**：`channel-gateway.ts` 多绑定时仅首个账号 `OPENCLAW_STATE_DIR` — 需方案或文档限制
- [ ] overlay 有 `weixin.accounts` 但无 bindings：日志/UI 是否足够清晰

### P1 — 运维

- [ ] 冷启动：仅有 overlay 账号、`channels.yaml` 未 enabled → `persistEnsureWeixinChannelGateway` 迁移
- [ ] 解绑/删用户：`onUnbound`、删账号后 `channels` restart；清理遗留 `weixin.pid`（`reapOrphanDefaultWeixin`）
- [ ] 按需 `git push origin main`

### P2 — 清理与兼容

- [ ] Gateway 内嵌企微插件（`channelGateway.enabled=false`）：文档标明 deprecated，推荐 channels
- [ ] 旧 yaml `weixin.mode: weixin-bot` → 归一 `external`（部分逻辑在 `gateway/index.ts`）
- [ ] 独立 `weixin-bot.ts` / `weixin.mjs`：保留调试，文档说明非 PM 生产路径
- [ ] 同进程 wecom + weixin：owner / `ct_`（`wecom-owner.ts`、`HttpUserTokenProvider`）

## 关键路径索引

| 主题 | 路径 |
|------|------|
| channels 主进程 | `backend/src/channels/channel-gateway.ts` |
| ilink 收发 | `backend/src/channels/weixin-bot.ts` |
| 绑定 | `backend/src/channels/weixin-binding.ts` |
| 扫码 API | `backend/src/gateway/weixin-login.ts` |
| 绑定持久化 | `backend/src/config/persist.ts` |
| channels 微信配置 | `backend/src/config/persist-weixin.ts`、`backend/src/gateway/channels/weixin-config-api.ts` |
| PM | `backend/src/supervisor/manager.ts` |
| 配置 schema | `shared/src/config.ts` → `channelGatewaySectionSchema` |
| 后台 | `web/src/pages/Weixin.tsx`、`Wecom.tsx`、`web/src/components/channel-gateway-log-panel.tsx` |

## 接手建议命令

```bash
pnpm install && pnpm setup:channels
pnpm typecheck
pnpm --filter @linkagent/backend test
pnpm dev
# 另终端或后台：保存渠道配置并 restart channels，或 pm restart channels
```

## 相关文档

- [`docs/channels.md`](channels.md) — 渠道总览（部分内容可能仍偏旧，以本文 P0 为准）
- [`docs/channel-gateway.md`](channel-gateway.md)
- [`docs/channel-gateway-integration.md`](channel-gateway-integration.md)
- [`AGENTS.md`](../AGENTS.md) — 开发流程与分层约定（微信小节已按 channels 单进程更新）
