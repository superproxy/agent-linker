#!/usr/bin/env node
/**
 * 解析某安装根下的网关 HTTP 端口（供 server.sh 健康检查用）。
 * 优先级：listen-port.json（pid 仍存活）> overlay gateway.server.port > gateway.yaml > 8787
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

function looksLikeInstallRoot(dir) {
  const r = resolve(dir);
  if (existsSync(join(r, ".linkagent-root"))) return true;
  if (existsSync(join(r, "bin", "gateway.mjs"))) return true;
  if (existsSync(join(r, "pnpm-workspace.yaml"))) return true;
  if (existsSync(join(r, "config", "gateway.yaml"))) return true;
  return false;
}

function installRoot() {
  const env = process.env.LINKAGENT_HOME?.trim();
  if (env) return resolve(env);
  const cwd = resolve(process.cwd());
  if (looksLikeInstallRoot(cwd)) return cwd;
  return cwd;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function yamlPort(root) {
  for (const rel of ["config/gateway.yaml", "config/config.yaml"]) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    try {
      const doc = parseYaml(readFileSync(p, "utf8"));
      const port = doc?.server?.port ?? doc?.gateway?.server?.port;
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    } catch {
      /* ignore */
    }
  }
  return 8787;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const root = installRoot();
const gwDir = join(root, ".runtime-state", "gateway");
const listen = readJson(join(gwDir, "listen-port.json"));
if (listen && pidAlive(listen.pid) && listen.port >= 1 && listen.port <= 65535) {
  process.stdout.write(String(listen.port));
  process.exit(0);
}
const overlay = readJson(join(gwDir, "overlay.json"));
const overlayPort = overlay?.gateway?.server?.port;
if (Number.isInteger(overlayPort) && overlayPort >= 1 && overlayPort <= 65535) {
  process.stdout.write(String(overlayPort));
  process.exit(0);
}
process.stdout.write(String(yamlPort(root)));
