# 运行配置（`<安装根>/config/`）

与 dist 包内 `config/` **同结构**。多进程共享本目录，按 **文件名** 分段，不要改成 `config/gateway/` 子目录。

| 文件 | 进程 / 用途 |
|---|---|
| `gateway.yaml` | gateway：监听、鉴权、agents、tasks、plugins |
| `channels.yaml` | channel-gateway：企微、飞书、微信插件 |
| `weixin.yaml` | 个人微信 bot（external） |
| `node.yaml` | 本机 node 连接器、serveWeb 等 |

- 模板：`backend/config/*.template`；`build:dist` 会在 dist 内生成 yaml 并附带 `*.template`。
- 重置：`bash scripts/config-init.sh`（仓库根或 dist 内，仅需 node）。
- 本目录下 `*.yaml` 已 gitignore；勿提交密钥。
