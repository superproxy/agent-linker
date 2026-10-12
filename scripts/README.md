# scripts/ 命名约定

| 前缀 | 用途 | 是否进入 `dist/linkagent` |
|------|------|---------------------------|
| `build-` | monorepo 构建产物 | 否（除 build-dist 自身） |
| `deploy-` | 发布包 ↔ 运行安装目录 | 仅 `deploy-install.sh` → 包根 `install.sh` + `lib/` |
| `migrate-` | 一次性配置/目录迁移 | 否 |
| `ops-` | 装好后运维（config、edge、setup） | 是，**拷贝时去掉 `ops-` 前缀** |
| `dev-` | 本机开发/联调（stack、server、node） | 否 |

**独立包内**（与 `bin/` 分工）：

- `bin/*.mjs` — 进程入口（gateway、pm、node…）
- `scripts/*` — 运维脚本（无 `ops-` 前缀）
- 包根 `install.sh` + `lib/` — 仅安装期

**薄封装（兼容旧路径）**：无 `deploy-`/`ops-`/`dev-` 前缀的同名文件（如 `server-install-update.sh`、`config-init.mjs`）转发到上表中的正式文件名。

`edge-ctl.mjs` 保持无前缀：pnpm `edge:*` 入口，内部分发到 `ops-edge.sh` / `edge.sh`（dist）。
