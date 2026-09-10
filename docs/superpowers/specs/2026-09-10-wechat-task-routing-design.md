# 微信多任务路由设计（Task Routing）

日期：2026-09-10
状态：待评审

## 1. 背景与目标

用户通过个人微信（单一聊天窗口）维护**多个工作任务**，每个任务绑定**不同的 agent**（如 `pi` / `opencode`）。由于微信只有一个会话窗口，需要一种机制让用户：

- 创建多个任务，每个任务绑定一个 agent；
- 在任务之间切换（"当前激活任务"）；
- 切换后，聊天内容进入该任务对应的 agent 会话。

**核心约束**：底层（网关 / ACP 会话）只有一个维度区分会话，即 `sessionKey`。因此多任务会话隔离通过 **把任务 id 编码进 sessionKey** 实现：`<channel>:<userId>:task:<taskId>`，每个任务拥有独立的持久会话记忆。

**能力定位**：任务管理是**独立公共能力**（类似独立服务，有清晰边界），与网关**同进程部署**（不额外起进程），所有渠道（个人微信 / 企业微信 / web 后台）共享。

## 2. 架构

```
微信/企微 bot（路由层，每个 bot 各自维护）
├── 内存态：当前选中 task（缺省用默认任务 default 兜底）
├── 用户输入判定：
│   ├─ /task xxx 特殊命令 → 转发网关（带 channel+userId）→ 网关解析命令、更新状态 → 回文本
│   └─ 普通消息 → bot 取当前选中 task → 带 { agent, userId, task } 调网关执行
└── bot 从命令响应 / /api/tasks 查询同步"选中 task"及其 agent

网关（公共能力，同进程部署）
├── TaskService：任务 CRUD、命令解析、用户状态持久化
├── /api/tasks 管理接口（web 后台点击用，走鉴权）
└── /v1/chat/completions 扩展：接收 { agent, userId, task }
    → agent → 适配器；userId+task → sessionKey → 走现有流式/非流式管道
```

### 职责划分

| 层 | 管什么 |
|---|---|
| 网关 | 任务清单增删改查、持久化、命令解析、agent 执行、会话隔离（公共能力，多渠道共享） |
| bot | 路由决策：当前选中哪个 task（默认任务兜底），选中后带 `agent+userId+task` 调网关 |

### 触发方式（等价语义）

| 界面 | 触发 | 网关入口 |
|---|---|---|
| 微信 | 特殊命令 `/task xxx` | `/v1/chat/completions`（带 channel+userId，命令本地解析回文本） |
| 普通页面（web 后台/控制台） | 点击操作 | `/api/tasks` |
| 任意渠道普通消息 | 自动路由 | `/v1/chat/completions`（带 agent+userId+task） |

## 3. 数据模型与持久化

每用户一份 JSON，存 `.runtime-state/tasks/<channel>.<userId>.json`（与现有 `.runtime-state/` 约定一致，可清理）：

```json
{
  "channel": "weixin",
  "userId": "wx_xxx",
  "activeTaskId": "t_2",
  "tasks": [
    { "id": "default", "name": "默认",   "agentId": "opencode", "createdAt": 1725... },
    { "id": "t_2",     "name": "排查链路bug", "agentId": "pi",  "createdAt": 1725... }
  ]
}
```

- `id`：`default` 或 `t_<短随机>`；
- `agentId`：`pi` | `opencode`（网关解析为模型 id `agent:<agentId>`）；
- **默认任务**：用户状态首次出现时预置 `default` 任务（agent 可配置，缺省 `opencode`），开箱可聊；
- **激活任务落盘**（`activeTaskId`，网关为单一事实源）：web 点击切换、微信命令切换都写同一字段，bot 侧只是该状态的缓存——重启后首次消息查询即可恢复，多渠道视角一致。

## 4. 命令集（网关解析，微信输入）

命令经 `/v1/chat/completions`（带 `channel` + `userId`）进入网关，由 TaskService 本地解析，**不走 agent**，结果文本走现有返回管道（非流式直接回文本，流式单块回）。bot 无需理解命令内容，只需从响应文本中同步路由信息。

| 命令 | 说明 |
|---|---|
| `/task new <名称> [agent]` | 新建任务；agent 缺省取当前选中任务的 agent（首次缺省 opencode）；响应带回新任务 id 与 agent |
| `/task list` | 列出所有任务：`[2] 排查链路bug → pi`（`[n]` 标记，配合响应让 bot 同步） |
| `/task use <id>` | 切换选中任务；响应明确返回目标 `{ agent, task }` |
| `/task del <id>` | 删除任务；删除选中任务时 bot 回落到默认任务 |
| `/task rename <id> <新名>` | 重命名 |
| `/task help` | 用法说明 |

命令响应统一为简洁文本，且**末尾附带机器可读的路由信息**（如 `ROUTE agent=pi task=t_2`），便于 bot 解析同步选中状态（或 bot 选择忽略，仅展示文本，靠 `/api/tasks` 兜底同步）。

## 5. 路由（bot 侧）与执行（网关侧）

### bot 路由逻辑（每个渠道一份，共享实现放共享层）

1. 启动 / 首次消息：若无内存选中态 → `GET /api/tasks?channel=&userId=` 拿激活任务（含 default 兜底），记为选中缓存；
2. 收到 `/task xxx` → 转发网关（channel+userId）→ 响应文本回用户，同时解析响应（或成功后重新查询）更新选中缓存；
3. 收到普通消息 → 带 `{ agent: 选中任务.agentId, userId, task: 选中任务.id }` 调 `/v1/chat/completions` 流式，正常推送。

> bot 的选中态只是网关 `activeTaskId` 的**缓存**：web 后台点击切换后，bot 下一次命令/查询即同步，无需 bot 侧持久化。

### 网关执行

- `agent` → 解析为模型 `agent:<agentId>`，走现有 `AgentManager.resolve`；
- `userId + task` → 派生 `sessionKey = <channel>:<userId>:task:<taskId>`，复用现有 ACP 持久会话（每任务独立记忆）；
- 缺 `agent/userId/task`（web 控制台、curl、旧客户端）→ 完全走原 `model + sessionKey` 兼容路径。

## 6. 管理 API（/api/tasks，web 后台点击）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks?channel=&userId=` | 用户任务列表（含 default） |
| POST | `/api/tasks` | 新建 `{ channel, userId, name, agentId? }` |
| PATCH | `/api/tasks/:taskId/activate` | 切换选中（更新 `activeTaskId`，供 bot 查询同步） |
| DELETE | `/api/tasks/:taskId` | 删除（default 不可删） |

鉴权与现有 `/api/*` 一致（`auth.enabled` 时需 Bearer token）。

## 7. 模块组织（网关内独立子系统）

```
backend/src/gateway/tasks/
├── service.ts      # TaskService：用户状态读写、任务 CRUD、命令解析、路由解析（纯逻辑，可单测）
├── store.ts        # JSON 持久化层（.runtime-state/tasks/）
└── api.ts          # /api/tasks 管理接口 + /v1 命令/路由接入点
```

依赖方向：`api → service → store`；只依赖 shared 类型与 AgentManager（agentId → 模型 id）。不引入"拦截器"组件——任务解析作为 `/v1/chat/completions` handler 内的一个分支（现有鉴权/模型解析同层），结果复用网关全部现有能力（流式/非流式/错误结构/鉴权）。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 未知 agent（任务绑定 `agent:xxx` 不存在） | 命令/路由返回明确错误文本，不静默降级 |
| `/task use/del` 不存在的 id | 返回错误文本并列出可用 id |
| 删除 `default` | 拒绝 |
| 用户状态文件损坏 | 按空状态重建（重新预置 default），日志告警 |
| 并发写同一用户状态 | 单写者（网关内单线程事件循环 + 简单序列化），写入失败重试一次 |

## 9. 渠道改造点

- `weixin-bot.ts`：路由层接入——维护选中任务内存态；命令转发（带 channel+userId）；普通消息改传 `{ agent, userId, task }`（替换原 sessionKey 传参）；共享路由逻辑抽到 `src/channels/task-router.ts` 供企微复用；
- `wecom-bot.ts`：同样接入共享路由层；
- 不改造的路径：web 控制台 / curl 直接用原 `model + sessionKey`。

## 10. 测试方案

- **单测（TaskService）**：命令解析（new/list/use/del/rename/help/错误分支）、默认任务预置、状态文件读写与损坏恢复；
- **冒烟（网关层）**：带 `{ agent, userId, task }` 调 /v1 → 验证路由到正确 agent 与 sessionKey；命令请求 → 返回文本不走 agent；
- **端到端（可选）**：weixin-bot + 真实登录态，微信里跑完整流程（默认任务 → new → use → 对话 → del）。

## 11. 已知限制 / 后续

- bot 选中任务为内存态，重启后首次消息需向 `/api/tasks` 查询恢复；
- 一期 `default` agent 配置走网关配置（`gateway.yaml` 新增 `tasks.defaultAgent`，缺省 opencode）；
- 删除任务不删会话（会话由 ACP 运行时管理，任务删除后会话自然孤立，后续可加清理）。
