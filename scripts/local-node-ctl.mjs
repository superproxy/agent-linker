#!/usr/bin/env node
/**
 * 本机纯节点（PM 原生 node 进程），不启 gateway/edge。支持 -f <node.env>。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeEntryEnvFileArgv, parseNodeEnvFileArgs } from "./lib/node-env-file-args.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(dir, "dev-node-ctl.mjs");
const parsed = parseNodeEnvFileArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(parsed.error);
  process.exit(1);
}
const ctlArgs = parsed.rest.length > 0 ? parsed.rest : ["start"];
const argv = ["--native", ...ctlArgs, ...nodeEntryEnvFileArgv(parsed.envFiles)];

if (ctlArgs[0] === "help" || ctlArgs[0] === "--help" || ctlArgs[0] === "-h") {
  console.log(`本机纯节点（原生 PM，不含 gateway/edge）

  node scripts/local-node-ctl.mjs [start|stop|restart|status|log|foreground] [-f <node.env>]
  scripts/local-node.sh / local-node.bat

pnpm local:node / local:node:stop …
`);
  process.exit(0);
}

const r = spawnSync(process.execPath, [target, ...argv], { stdio: "inherit" });
process.exit(r.status ?? 1);
