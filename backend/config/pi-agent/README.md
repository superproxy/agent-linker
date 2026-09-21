# pi 模型配置

用仓库脚本安装 CLI 并生成 `~/.pi/agent` 配置（密钥走环境变量，不写进 git）：

```bash
pnpm setup:pi
# 或：node scripts/setup-pi.mjs
export ARK_API_KEY=你的火山方舟密钥
```

模板：

- `models.json.template` → `~/.pi/agent/models.json`（provider `my`，火山方舟 OpenAI 兼容）
- `settings.json.template` → 合并进 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`

已有 `models.json` 默认不覆盖（`--force` 才覆盖）。`config.yaml` 的 `agents[].model` 请留空，让 ACP 沿用 pi 默认。

完整说明见仓库 [`docs/pi.md`](../../../docs/pi.md)。
