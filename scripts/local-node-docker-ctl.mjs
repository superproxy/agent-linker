#!/usr/bin/env node
/**
 * Docker 聚合节点 linkagent-node（node + IDE + 容器内 frpc）。支持 -f <node.env>。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeEntryEnvFileArgv, parseNodeEnvFileArgs } from "./lib/node-env-file-args.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(dir);
const ctl = path.join(repo, "code-server", "node-docker", "ctl.mjs");

const parsed = parseNodeEnvFileArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(parsed.error);
  process.exit(1);
}
const ctlArgs = parsed.rest.length > 0 ? parsed.rest : ["start"];

if (ctlArgs[0] === "help" || ctlArgs[0] === "--help" || ctlArgs[0] === "-h") {
  console.log(`Docker 聚合节点（linkagent-node 容器）

  node scripts/local-node-docker-ctl.mjs [build|start|stop|restart|status|log|foreground] [-f <node.env>]
  scripts/local-node-docker.sh / local-node-docker.bat

配置：.runtime-state/node.env 或 code-server/node-docker/node.env
pnpm local:node:docker / node:docker:*
`);
  process.exit(0);
}

const child = spawn(process.execPath, [ctl, ...ctlArgs, ...nodeEntryEnvFileArgv(parsed.envFiles)], {
  stdio: "inherit",
  cwd: path.join(repo, "code-server", "node-docker"),
});

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
