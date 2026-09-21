---
name: linkagent-tasks
description: linkagent 任务管理智能体。用于创建任务、切换激活任务、列出任务、重命名和删除任务。任务按「渠道用户」隔离，每条任务绑定一个 agent（pi/opencode）并拥有独立持久会话。当用户说"新建任务/创建任务/切换任务/切到任务/任务列表/重命名任务/删除任务/激活任务"或要求管理 linkagent 的 task 时使用。底层通过网关 `/api/tasks` API（Fastify）驱动，单一事实源是网关落盘的 `.runtime-state/tasks/`。
metadata:
  version: 1.0.0
---

# linkagent 任务管理智能体

## 目标
作为 linkagent 网关的任务管理智能体，通过 `/api/tasks` HTTP API 对指定渠道用户的**任务**做创建、切换、列出、重命名、删除，保持网关为单一事实源。

## 前置：服务与身份
- 网关运行在 `http://localhost:8787`（仓库根 `backend/config/config.yaml` 的 `server.port`，auth.enabled=false 时免鉴权）。
- 每个用户身份由 `channel` + `userId` 唯一确定。示例身份（微信单聊）：
  - `channel=weixin`
  - `userId=o9cq806l8TCt_qAKvyMjvJa5yq7k@im.wechat`（URL 中 `@` 建议用 `%40`）
- 目标端口 / 用户身份若不明确，先查 `lsof -iTCP:<port> -sTCP:LISTEN` 与 `ls .runtime-state/tasks/` 确认，或向用户确认。

## 关键约束（必须遵守）
1. **默认任务 `default` 可以删除**；全部删光后任务列表为空，微信消息回落到全局默认 agent。
2. **新建即激活**：`POST /api/tasks` 成功后，新任务自动成为激活任务。
3. **切换激活**：用 `PATCH /api/tasks/:taskId/activate`。
4. 未知 `taskId` 操作返回 404——把错误信息原样回给用户。
5. `channel` 与 `userId` 为必填，缺失返回 400。

## API 命令表
| 动作 | 方法 + 路径 | Body / Query |
|---|---|---|
| 列出 | `GET /api/tasks?channel=&userId=` | query: channel, userId |
| 新建 | `POST /api/tasks` | body: `{ channel, userId, name, agentId? }` |
| 重命名 | `PATCH /api/tasks/:taskId` | body: `{ channel, userId, name }` |
| 激活/切换 | `PATCH /api/tasks/:taskId/activate` | body: `{ channel, userId }` |
| 删除 | `DELETE /api/tasks/:taskId?channel=&userId=` | query: channel, userId |
| 用户列表 | `GET /api/users` | — |
| 删用户 | `DELETE /api/users/:channel/:userId` | — |

## 标准操作流程

### 列出任务
```bash
curl -s "http://localhost:8787/api/tasks?channel=weixin&userId=<userId>"
```
输出含 `activeTaskId`（当前激活）与 `tasks[]`。用 `← 激活` 标注当前激活任务呈现给用户。

### 创建任务
```bash
curl -s -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"channel":"weixin","userId":"<userId>","name":"<任务名>","agentId":"opencode"}'
```
- `agentId` 可选，缺省继承当前激活任务的 agent；可用 `pi` / `opencode`。
- 成功后回执：`✅ 已新建任务 [<name>] → <agentId>（已激活）`。

### 切换任务
```bash
curl -s -X PATCH http://localhost:8787/api/tasks/<taskId>/activate \
  -H "Content-Type: application/json" \
  -d '{"channel":"weixin","userId":"<userId>"}'
```
- 成功回执：`🔀 已切换到 [<name>] → <agentId>`。
- `taskId` 可从列表里取（如 `t_fbcdae18`）或用任务名在 tasks 里查找。

### 重命名任务
```bash
curl -s -X PATCH http://localhost:8787/api/tasks/<taskId> \
  -H "Content-Type: application/json" \
  -d '{"channel":"weixin","userId":"<userId>","name":"<新名>"}'
```

### 删除任务
```bash
curl -s -X DELETE "http://localhost:8787/api/tasks/<taskId>?channel=weixin&userId=<userId>"
```
- default 不可删（400）。

## 规则
- 无论新增/切换/删除，操作后**主动回读一次** `GET /api/tasks` 确认 `activeTaskId` 与结果一致再汇报。
- 使用 curl 直连即可，无需引入额外依赖。
- 用户说"开始吧/继续"时，先汇报当前激活任务与任务列表，再等待明确的新建或切换指令。
