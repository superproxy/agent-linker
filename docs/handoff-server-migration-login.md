# 服务端迁移 · 无法登录 — 交接说明（给其他智能体）

给下一个 agent。**不要依赖本对话**。以 **git、本文、`docs/deployment.md` §10、代码** 为准。

## 接手第一句（复制改日期/commit）

```text
请按 docs/handoff-server-migration-login.md 接手。
现象：服务端布局迁移后 Web 管理后台不能登录。
先确认网关实际读的是哪个「安装根」下的 .runtime-state/users，再查 auth.mode 与账号是否迁入。
不要 stash pop 覆盖已拉取的迁移脚本；不要把 .ssh / 密码写进文档或提交。
当前 git：在服务器与本地各执行 git log -1 && git status。
```

## 背景（与本次问题相关）

| 项 | 说明 |
|---|---|
| 目标 | 从「在 `dist/linkagent` 或分散路径跑」迁到 **仓库构建 + 运行目录分离**（默认 `/opt/agent-linker`） |
| 相关提交 | `cfebddb`（默认 `../linkagent`）→ `69b7b6a`（默认 `/opt/agent-linker` + 迁移脚本）→ `e54bd54`（`migrate-server-from-legacy.sh` 两步） |
| 文档 | `docs/deployment.md` **§10 安装根与迁移** |
| 登录实现 | `backend/src/gateway/users/api.ts`（`/api/auth/login`、`/api/auth/me`）、`users/store.ts`（`.runtime-state/users/`） |
| 安装根解析 | `backend/src/install/layout.ts`（`resolveRepoInstallRoot`、`.linkagent-server`、`.linkagent-install`）、`scripts/lib/install-root.sh` |

**结论（高概率，非网关 APISIX 业务路由问题）**：迁移后进程仍在读 **A 目录** 的 `.runtime-state`，而 **B 目录** 里才有旧账号；或 `/opt/agent-linker/.runtime-state/users` 已存在空目录，导致 **合并脚本跳过** 旧 `accounts/*.json`，表现为「密码不对 / 永远 401 / 看不到初始密码」。

---

## 1. 原理：登录凭据落在哪

| 路径（相对**实际安装根**） | 内容 |
|---|---|
| `.runtime-state/users/accounts/*.json` | 账号密码哈希（scrypt） |
| `.runtime-state/users/sessions/` | 浏览器会话 token（迁移后旧 token 自然失效，需重新登录） |
| `.runtime-state/users/admin-initial-password` | 首次生成 admin 时的明文（0600）；改密后删除 |
| `.runtime-state/gateway-token` | 静态 gateway token（与 Web **会话** login 不同） |
| `config/gateway.yaml` → `auth.mode` | `local`（免登录本机用户）/ `token`（要账号或静态 token）/ `open` |

Web 登录流程：

1. 前端 `GET /api/auth/me`（`web/src/App.tsx`）
2. `auth.mode=token` 且无有效 Bearer → 401，可能带 `initialAdmin`（**仅当账号库刚创建 admin 且 `request.ip` 为回环**）
3. `POST /api/auth/login` → 返回会话 token，写入 localStorage

**注意**：网关 Fastify **未** 配置 `trustProxy`（`gateway/index.ts`）。经 Nginx/SLB 访问时 `request.ip` 往往不是 `127.0.0.1`，**不会在登录页 JSON 里回显** `initialAdmin`，只能看 **本机** `curl 127.0.0.1:8787/api/auth/me` 或日志里的「已生成初始管理员…密码：…」（`users/api.ts` → `bootstrapInitialAdmin`）。

---

## 2. 迁移脚本行为（易踩坑）

| 脚本 | 行为 |
|---|---|
| `scripts/migrate-config.sh` | 在 **clone 根** 合并 `config/`（多源；`--with-runtime` 才合并 `.runtime-state`） |
| `scripts/migrate-install-config.sh` | 复制 `config/` 到 `LINKAGENT_INSTALL`（默认 `/opt/agent-linker`），写 `.linkagent-install` |
| `scripts/migrate-server-from-legacy.sh` | **必须先 1 再 2** |
| `scripts/server-install-update.sh` | `build:dist` → 同步到 `$INSTALL`，**不覆盖** 已有 `config/`、`.runtime-state/`；写 `repo/.linkagent-install` + `touch .linkagent-server`；`--restart` 时 `LINKAGENT_HOME=$INSTALL ./start.sh restart gateway` |

`scripts/lib/migrate-install.mjs` → `mergeRuntimeInto`：**只复制目标尚不存在的相对路径**，**不覆盖**已有文件。

典型故障：

1. 先 `server-install-update` 在 `/opt` 建了空 `.runtime-state/users/`，再跑 migrate → **旧 `accounts/admin.json` 不会覆盖进去**。
2. 仍用 `pnpm dev` / 仓库根 PM 启 gateway → 读 **仓库** `.runtime-state`，而账号在 **/opt**（或反过来）。
3. 新 `config/gateway.yaml` 里 `auth.token` 与旧环境不一致 → 节点/客户端仍用旧 token（与 Web 登录不同，但易混淆）。
4. `auth.mode: token` 但账号目录为空 → 远程访问看不到初始密码，用户以为「不能登录」。

---

## 3. 诊断清单（在服务器上执行）

假设 clone 在 `/root/agent-linker`，默认安装 `/opt/agent-linker`。**不要**在输出里打印 token/密码/hash。

### 3.1 确认安装根与进程

```bash
# 仓库是否已切到「服务器部署」模式
test -f /root/agent-linker/.linkagent-server && echo has-server-marker || echo no-marker
cat /root/agent-linker/.linkagent-install 2>/dev/null || echo no-install-file

# 两边是否都有用户目录
ls -la /root/agent-linker/.runtime-state/users/accounts 2>/dev/null | head
ls -la /opt/agent-linker/.runtime-state/users/accounts 2>/dev/null | head

# 网关监听与 health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz

# 本机看鉴权态（无 Bearer）
curl -s http://127.0.0.1:8787/api/auth/me | head -c 500; echo

# 看 gateway 用的配置片段（勿贴 token）
grep -E '^auth:|mode:|sessionTtl' /opt/agent-linker/config/gateway.yaml /root/agent-linker/config/gateway.yaml 2>/dev/null
```

对比 **哪一侧 `accounts/` 有 `admin.json`（或其它用户）** 与 **当前进程 cwd / LINKAGENT_HOME**（`ps aux | grep gateway`、`.runtime-state/pm/logs/gateway.log` 前几行）。

### 3.2 区分错误类型

| 现象 | 可能原因 |
|---|---|
| 登录页 401，`invalid_credentials` | 账号在别的 state 根；或密码确实不对 |
| 登录页 401，无 `initialAdmin`，账号目录空 | 非回环 IP + 新生成 admin；需本机 curl/me 或读日志/ `admin-initial-password` |
| `pnpm dev` 能进、`/opt` 启动不能 | 两套 `.runtime-state` |
| 根本进不了登录页（502/404） | 边缘 APISIX/nginx 或 gateway 未起；**不是**账号问题，先 `healthz` |
| `auth.mode=local` 仍出现登录页 | 前端仍 401（例如静态资源旧包、或请求打到未启服务）；查 `auth/me` 应返回 `local: true` |

### 3.3 迁移是否漏账号（手动对比）

```bash
# 旧数据常见位置（按存在性检查，不要删）
for d in \
  /root/agent-linker/dist/linkagent/.runtime-state/users/accounts \
  /root/agent-linker/.runtime-state/users/accounts \
  /opt/agent-linker/.runtime-state/users/accounts
do
  [ -d "$d" ] && echo "== $d" && ls "$d"
done
```

若 **仅** `dist/linkagent` 或 **仅** 仓库根有 `admin.json`，而 `/opt` 没有 → 按 §4 修复。

---

## 4. 恢复流程（按顺序，生产前备份）

### 4.1 标准：补全迁移后再部署

```bash
cd /root/agent-linker
# 若 /opt 从未正确迁入，或 users 为空但别处有账号：
LINKAGENT_LEGACY_ROOT=/root/agent-linker/dist/linkagent \
  bash scripts/migrate-server-from-legacy.sh
# 或仅仓库内整理：
# bash scripts/migrate-config.sh --with-runtime
# LINKAGENT_INSTALL=/opt/agent-linker bash scripts/migrate-install-config.sh --with-runtime

bash scripts/server-install-update.sh --restart
```

若 `/opt/.../users/accounts` 已有**错误/空**占位文件阻止合并：先 **备份** `/opt/agent-linker/.runtime-state/users`，再将有账号的一侧 **显式复制**（运维操作，谨慎覆盖）：

```bash
# 示例：仅当确认 /opt 无有效账号、仓库根有账号时
install -d -m 700 /opt/agent-linker/.runtime-state/users/accounts
cp -a /root/agent-linker/.runtime-state/users/accounts/. \
  /opt/agent-linker/.runtime-state/users/accounts/
# 同步 sessions 可选；旧会话可不要，用户重新登录即可
```

然后：

```bash
cd /opt/agent-linker && LINKAGENT_HOME="$PWD" ./start.sh restart gateway
# 或 server-install-update.sh --restart
```

### 4.2 忘记 admin 密码（账号已在正确 state 根）

见 `docs/deployment.md` §4.1.1：停网关 → 删 `accounts/admin.json` 与 `admin-initial-password` → 启动 → **本机** `curl http://127.0.0.1:8787/api/auth/me` 或查 gateway 日志拿一次性密码 → 登录后改密。

### 4.3 临时免登录（仅内网排障，勿长期公网）

`config/gateway.yaml` 设 `auth.mode: local`（`auth.ts`：无效浏览器 token 也当本机用户）。**公网暴露必须改回 `token`**。

### 4.4 构建与前端

迁移后若只更新了后端、未构建 web：

```bash
cd /root/agent-linker
bash -lc 'pnpm build:web'
bash scripts/server-install-update.sh --restart
```

生产进程读的是 **安装目录** 内 `web/`（由 `build:dist` 打进发布包再 sync），不是仓库 `web/dist`  alone。

---

## 5. 与「边缘 / 任务域名」的关系

- 任务页 `{name}-{id}-web.localhost:8088` 经 APISIX 反代到 **同一 gateway 8787**（`backend/src/gateway/edge/`）。
- **登录 API 与静态 UI 同源**：任务 web 域名下 `/api/auth/login` 仍走网关；502 先查 gateway/APISIX，不是「迁移专门破坏登录路由」。
- 本地开发 **Cursor 内置浏览器** 跨站 iframe 预览 dev 页空白，与 **服务端登录** 无关（见前序排查：Chrome/Playwright 正常）。

---

## 6. 待办（给接手 agent）

### P0 — 恢复生产登录

- [ ] 在目标服务器完成 §3 诊断，记录：**实际 LINKAGENT_HOME**、**accounts 所在目录**、**auth.mode**
- [ ] 按 §4 把 `users/accounts` 对齐到运行中的安装根，重启 gateway，验证 `POST /api/auth/login`（本机 curl，勿写密码到 issue）
- [ ] 确认对外 URL（域名/IP:端口）与 Nginx `proxy_pass` 指向 **正在读正确 state 的那台 gateway**

### P1 — 降低再发

- [ ] 评估是否在 `gateway/index.ts` 增加可配置 `trustProxy`（Nginx 后正确识别回环/客户端 IP，便于 `initialAdmin` 策略）——**先写方案再改**
- [ ] 迁移脚本：当目标 `users/accounts` 为空目录时，允许从源 **合并覆盖**（或打印明确 warning）——**先写方案再改**
- [ ] 启动时日志打印一行 **resolved install root + usersState**（不含密钥）——便于排障

### P2 — 文档

- [ ] 在 `docs/deployment.md` §10 增加「迁移后登录失败」链到本文（若 P0 验证通过再改）

---

## 7. 关键代码索引

| 主题 | 路径 |
|---|---|
| 安装根 | `backend/src/install/layout.ts` |
| 登录 API | `backend/src/gateway/users/api.ts` |
| 鉴权 | `backend/src/gateway/users/auth.ts` |
| 账号 store | `backend/src/gateway/users/store.ts` |
| 迁移合并 | `scripts/lib/migrate-install.mjs`、`scripts/lib/migrate-run.mjs` |
| 服务器部署 | `scripts/server-install-update.sh`、`scripts/migrate-server-from-legacy.sh` |
| 前端登录 | `web/src/App.tsx`、`web/src/pages/Login.tsx` |

---

## 8. 约束（与 AGENTS.md 一致）

- 非 trivial 改代码前：现状 / 流程 / 方案。
- 不要提交：`.ssh`、`backend/scripts/` 探测脚本、`.runtime-state/`、明文密钥。
- 不要 **`git stash pop`** 覆盖服务器上为 pull 暂存的旧改动（参考 `docs/handoff-feishu-remote.md` 教训）。
- 测试基线：`pnpm --filter @linkagent/backend test`（改后端时）。

---

## 9. 本地仓库状态（撰写时）

- 分支：`main`（撰写时本地 `git log -1` 为 `e54bd54`，以接手时 `git log -1` 为准）
- 本文 **未** 提交；接手 agent 可随 P0 修复一并提交，或单独 docs commit。
