# 飞书收发与远程更新交接

给下一个 agent。不要依赖本对话。以 git、本文和代码为准。

## 接手第一句

```text
请按 docs/handoff-feishu-remote.md 接手。
先读该文档和 AGENTS.md。不要把远程 git stash pop 回来。
接着做「未完成」：在 216.19.4.113 的 /root/agent-linker 按历史命令 build:web 并 restart:all。
凭证只读仓库根目录 .ssh，不要把密码写进文档、提交或日志。
```

## 已完成

飞书单聊文本已通。入站按微信同一套任务路由进 `/v1`（`channel=feishu`、`userId=open_id`、`ownerUsername`、`traceId`），回复走 `im.message.reply`。用户已在本机确认能收到回复。

| 项 | 状态 |
|---|---|
| 代码 | `backend/src/channels/feishu-bot.ts`、`gateway-chat.ts`（`source` 可传入，缺省仍是 `weixin-bot`） |
| 提交 | `f36a29c` `fix: 飞书入站按微信任务路由派发并记录回推结果` |
| 远程 git | 已推送 `origin/main`（`8213a27..f36a29c`） |
| 本机验收 | channels 日志 `traceId=363407e5e270`，`channels.v1.response ok=true`，`outbound len=16`，`delivered=true` |
| 服务器拉代码 | `216.19.4.113:/root/agent-linker` 已 `git pull --ff-only`，HEAD 为 `f36a29c` |

本机未入库、不要提交：仓库根 `.ssh`（含主机、端口、账号、密码）、`backend/scripts/`、误生成文件 `backend/{console.error(e.message)`。

## 未完成（接手就做）

服务器代码已是 `f36a29c`，进程还是旧的。`/root/.bash_history` 里反复出现的更新顺序是：

```bash
cd /root/agent-linker
git pull
pnpm build:web
pnpm restart:all
```

`git pull` 已完成。剩下 `pnpm build:web` 和 `pnpm restart:all`。

非登录 shell 里 `pnpm` 不在 PATH（`pnpm: command not found`）。用登录 shell：

```bash
bash -lc 'cd /root/agent-linker && pnpm build:web && pnpm restart:all'
```

这次 lockfile 新增了 `@larksuiteoapi/node-sdk`。历史命令没有 `pnpm install`。若 `build:web` 或 channels 启动报找不到该包，先在同一目录执行 `pnpm install`，再 `pnpm restart:all`。

重启后看 `/root/agent-linker/.runtime-state/pm/logs/channels.log`，应出现 `飞书长连接已启动`。再让用户在飞书单聊发一条文本，确认有 `channels.v1.request` 和 `[feishu] outbound`。

## 服务器现状（2026-09-24）

- 连接：`ssh 216.19.4.113 -l root -p 5222`。密码在仓库根 `.ssh` 第三行，不要写入本文。
- 目录：`/root/agent-linker`，分支 `main`，与 `origin/main` 对齐到 `f36a29c`。
- 为能快进，已把冲突的已跟踪改动放进 stash：`git stash push -m pre-update-f36a29c`（含 `backend/package.json`、`backend/src/gateway/index.ts`、`backend/src/install/layout.ts`、`backend/src/supervisor/manager.ts`、`pnpm-lock.yaml`、`shared/src/config.ts` 以及三个 yaml template 的删除）。**不要 `stash pop`**，否则会把刚拉下来的渠道代码盖回去。
- 未跟踪、拉取时保留：`.pi/`、`backend/src/gateway/proxy/`、`backend/src/gateway/services/`、`backend/src/remote/`、`docs/proxy-frps.md`、`vibecoding/`。
- 拉取前看到的进程（重启前会仍是旧代码）：`channel-gateway.ts`、若干 `weixin-bot.ts`、`node/connector.ts`。当时没看到 gateway 主进程名字，以 `pnpm restart:all` 的实际输出为准。

## 行为边界

- 飞书只处理单聊文本（`p2p` / `private`）。群消息、非文本、webhook 不在本进程启动。
- 网关进程不加载 `@openclaw/feishu`。后台保存仍可能把 `feishuPluginPackage` 写入 `channels.yaml`，channels 会忽略。
- 任务空间 owner 在 `auth.mode=local` 时是 `local`，与微信相同，走 `ensureLoginSpace`。
