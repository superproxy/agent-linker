---
name: linkagent-tasks
description: >
  linkagent 任务管理。用于列出、创建、激活、重命名、改绑、删除当前登录用户的任务。
  身份是登录账号级（web/<username> + pat_），不要用微信联系人 id 或任务 key k_。
  当用户说新建任务、创建任务、切换任务、任务列表、重命名、删除、激活任务时使用。
metadata:
  version: 2.1.0
---

# linkagent 任务管理

通过网关 `/api/tasks` 管理**当前登录用户**的任务。网关是唯一事实源。

本 skill 只挂在**默认任务**（本机 `pi`）。其它任务不注入凭据。

## 参数从哪来（用户级，禁止猜）

优先读**进程环境变量**（网关启动本机 pi 时注入，不要手写 token）：

| 环境变量 | 用途 |
|---|---|
| `LINKAGENT_BASE_URL` | 网关根，如 `http://127.0.0.1:8787` |
| `LINKAGENT_CHANNEL` | 固定 `web`（登录任务空间，不是 weixin） |
| `LINKAGENT_USER_ID` | 登录用户名 |
| `LINKAGENT_OWNER` | 同上 |
| `LINKAGENT_TOKEN` | `pat_…` 个人 API token，**用户级**，可管该账号下全部任务 |
| `LINKAGENT_TOKEN_KIND` | 应为 `personal` |
| `LINKAGENT_TASK_ID` | 当前默认任务 id（`default`） |

若环境变量缺失，才可读工作目录 `.linkagent/identity.json`（同名字段）。不要把 `k_` 当 API token。

每次请求：

```
Authorization: Bearer $LINKAGENT_TOKEN
X-LinkAgent-Skill: 1
Content-Type: application/json
```

`X-LinkAgent-Skill: 1` 表示用户视角。带此头时只用 `pat_` / 登录会话 / `ct_`；`k_`、网关静态 token 会 403。

创建/列表的 `channel`、`userId` **必须**抄环境变量，不要问用户微信 openid，也不要编。

优先 `GET /api/tasks/all`（凭 pat_ 只返回本人空间，不必再拼 query）。写接口仍带 body 里的 `channel` + `userId`。

## 约束

1. 默认任务 `default` **可以删**；删光后列表为空，微信普通消息回落到全局兜底 agent。要补回：`/task new default`（固定本机 `pi`，并成为激活任务）。
2. 默认任务固定本机 `pi`，不能改 `agent`/`node`。
3. 普通用户**不能**把新任务绑到本机 `local`；须用自己的远程 `nodeId`。管理员可以把任务绑到 `local`。
4. `POST /api/tasks` 成功后新任务自动成为激活任务。
5. 未知 `taskId` → 404，把错误原文告诉用户。
6. 改完再 `GET /api/tasks/all` 核对 `activeTaskId` 再汇报。

## API

| 动作 | 方法 | 用户级参数 |
|---|---|---|
| 列出本人全部 | `GET /api/tasks/all` | 仅 Header（pat_） |
| 列出（兼容） | `GET /api/tasks?channel=&userId=` | query 用 env 的 channel/userId |
| 新建 | `POST /api/tasks` | body: `{ channel, userId, name, agentId?, nodeId?, cwd?, key? }` |
| 重命名 / cwd / key 开关 | `PATCH /api/tasks/:taskId` | body: `{ channel, userId, name?, cwd?, keyEnabled? }` |
| 改绑节点+agent | `PATCH /api/tasks/:taskId/agent` | body: `{ channel, userId, agentId, nodeId? }` |
| 激活 | `PATCH /api/tasks/:taskId/activate` | body: `{ channel, userId }` |
| 删除 | `DELETE /api/tasks/:taskId?channel=&userId=` | query 用 env |

`ownerUsername` 普通用户可省略（网关强制本人空间）；管理员操作他人空间时才加。

## curl（占位全部来自环境变量）

```bash
BASE="$LINKAGENT_BASE_URL"
CH="$LINKAGENT_CHANNEL"
UID="$LINKAGENT_USER_ID"
TOK="$LINKAGENT_TOKEN"
```

### 列出

```bash
curl -s "$BASE/api/tasks/all" \
  -H "Authorization: Bearer $TOK" \
  -H "X-LinkAgent-Skill: 1"
```

用 `activeTaskId` 与 `tasks[]` 回复用户，当前激活标 `← 激活`。

### 创建

```bash
curl -s -X POST "$BASE/api/tasks" \
  -H "Authorization: Bearer $TOK" \
  -H "X-LinkAgent-Skill: 1" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"$CH\",\"userId\":\"$UID\",\"name\":\"<任务名>\",\"agentId\":\"<远程agentId>\",\"nodeId\":\"<远程节点id>\"}"
```

- `agentId` / `nodeId` 可选；缺省继承当前激活任务。普通用户不要传 `nodeId: local`。
- 成功：`已新建任务 [<name>] → <agentId>@<nodeId>（已激活）`。

### 激活

```bash
curl -s -X PATCH "$BASE/api/tasks/<taskId>/activate" \
  -H "Authorization: Bearer $TOK" \
  -H "X-LinkAgent-Skill: 1" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"$CH\",\"userId\":\"$UID\"}"
```

`taskId` 来自列表（如 `t_fbcdae18`）或按名称查找。

### 重命名

```bash
curl -s -X PATCH "$BASE/api/tasks/<taskId>" \
  -H "Authorization: Bearer $TOK" \
  -H "X-LinkAgent-Skill: 1" \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"$CH\",\"userId\":\"$UID\",\"name\":\"<新名>\"}"
```

### 删除

```bash
curl -s -X DELETE "$BASE/api/tasks/<taskId>?channel=$CH&userId=$UID" \
  -H "Authorization: Bearer $TOK" \
  -H "X-LinkAgent-Skill: 1"
```

## 不要做的事

- 不要把 `k_` 放进 `Authorization` 去调 `/api/tasks`。
- 不要用 `channel=weixin` + 微信 peer 当任务空间（任务按登录账号，不按联系人）。
- 不要编造 token，不要把 token 写进工作目录或提交到 git。
