# scripts/ 命名约定

| 前缀 | 用途 | 是否进入 `dist/linkagent` |
|------|------|---------------------------|
| `build-` | monorepo 构建产物 | 否（除 build-dist 自身） |
| `deploy-` | 发布包 ↔ 运行安装目录 | 仅 `deploy-install.sh` → 包根 `install.sh`（逻辑内联，无 lib/） |
| `ops-` | 装好后运维（config、edge、setup） | 是，**拷贝时去掉 `ops-` 前缀** |
| `dev-` | 本机开发/联调（stack、server、node） | 否 |
| `local-` | **本机 PM 栈/节点**（非 `pnpm dev` 源码模式） | 否 |

**独立包内**（与 `bin/` 分工）：

- `bin/*.mjs` — 进程入口（gateway、pm、node…）
- `scripts/*-ctl.*` — 运维启停（`edge-ctl`、`server-ctl`）
- 包根 `edge-ctl.sh` / `server-ctl.sh` — 转发到 `scripts/` 同名脚本
- 包根 `install.sh` — **唯一**安装入口（Release 解压后 `./install.sh`）

**ctl 格式**（仓库与 dist 对齐）：

- 边缘：`edge-server-ctl`（`pnpm edge:*` 启停 frps+APISIX）· `edge-config-ctl`（`pnpm edge:config` 只写配置）· `scripts/edge/` 为 Compose · `edge-ctl` / `edge.sh` 兼容转发
- 网关三进程：dist 内 `server-ctl.mjs` / `scripts/server-ctl.sh`；源码开发仍用 `dev-server-ctl.mjs`

**薄封装（兼容）**：包根 `start.sh` / `start.bat` 转发到 `server-ctl`；无 `deploy-`/`ops-`/`dev-` 前缀的旧文件名仍可能转发到正式脚本。

`migrate-*` 脚本仍保留在仓库供历史数据手工整理，**不**打进 dist，**无** pnpm 别名。

**本机启动（local-*，PM + edge，非 tsx dev）**

| 脚本 | 含义 |
|------|------|
| `local-stack.sh` / `.bat` / `local-stack-ctl.mjs` | 完整栈：edge + gateway + channels + 原生 PM node |
| `local-stack-enhance.*` | 同上 + edge 增强 + 单机 code-server + 宿主机 frpc |
| `local-node.*` / `local-node-ctl.mjs` | **仅**原生 node 连接器 |
| `local-node-docker.*` / `local-node-docker-ctl.mjs` | **仅** Docker `linkagent-node` |

pnpm：`local:start`、`local:enhance`、`local:worker` / `local:node`（等价）、`local:worker:docker` / `local:node:docker`；工作节点启停亦可用 `pnpm worker:*` / `pnpm node:*`（`local:stack:*` 仍可用）。

组件运维总览（端口、日志、frpc、启停顺序）：[`docs/ops-local-components.md`](../docs/ops-local-components.md)。
