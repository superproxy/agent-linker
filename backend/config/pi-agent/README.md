# pi 模型配置

网关**不附带、不写死**任何厂商模型清单（包括火山方舟）。

模型注册与默认会话模型由 **pi / pi-acp 自己安装和维护**：

- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`（`defaultProvider` / `defaultModel`）

后台「安装」只装 CLI（`npm i -g pi-acp`，并需本机已有 `pi`）。装完后用 pi 自己的命令或配置加 provider，不要把 `volcengine/...` 写进 `config.yaml` 的 `agents[].model`。

网关 `agents[].model` 请留空，让 ACP 沿用 pi 默认；只有确认该 id 已出现在本机 `models.json` 时才覆盖。
