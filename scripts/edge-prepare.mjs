#!/usr/bin/env node
/**
 * 写入边缘配置并输出 edge.sh / edge.ps1 所需的键值行（与 bin/edge.mjs、tsx edge/cli 一致）。
 * 安装根：LINKAGENT_HOME，否则 cwd（含 dist 独立包与 monorepo 根）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoFromScripts = resolve(scriptsDir, "..");

function looksLikeInstallRoot(dir) {
  const r = resolve(dir);
  if (existsSync(join(r, ".linkagent-root"))) return true;
  if (existsSync(join(r, "bin", "gateway.mjs"))) return true;
  if (existsSync(join(r, "pnpm-workspace.yaml"))) return true;
  if (existsSync(join(r, "config", "gateway.yaml"))) return true;
  return false;
}

function findInstallRoot() {
  const env = process.env.LINKAGENT_HOME?.trim();
  if (env) return resolve(env);
  const cwd = resolve(process.cwd());
  if (looksLikeInstallRoot(cwd)) {
    if (basename(cwd) === "backend" && existsSync(join(dirname(cwd), "pnpm-workspace.yaml"))) {
      return dirname(cwd);
    }
    return cwd;
  }
  if (looksLikeInstallRoot(repoFromScripts)) return repoFromScripts;
  return cwd;
}

function runPrepare(root) {
  const env = { ...process.env, LINKAGENT_HOME: root };
  const distCli = join(root, "bin", "edge.mjs");
  if (existsSync(distCli)) {
    return spawnSync(process.execPath, [distCli], { cwd: root, encoding: "utf8", env });
  }
  const legacyCli = join(root, "server", "edge.mjs");
  if (existsSync(legacyCli)) {
    return spawnSync(process.execPath, [legacyCli], { cwd: root, encoding: "utf8", env });
  }
  const monorepoRoot = existsSync(join(root, "pnpm-workspace.yaml"))
    ? root
    : existsSync(join(repoFromScripts, "pnpm-workspace.yaml"))
      ? repoFromScripts
      : null;
  if (monorepoRoot) {
    const tsxLoader = join(monorepoRoot, "backend", "node_modules", "tsx", "dist", "esm", "index.mjs");
    const cli = join(monorepoRoot, "backend", "src", "gateway", "edge", "cli.ts");
    if (existsSync(tsxLoader) && existsSync(cli)) {
      return spawnSync(
        process.execPath,
        ["--import", pathToFileURL(tsxLoader).href, cli],
        { cwd: monorepoRoot, encoding: "utf8", env },
      );
    }
  }
  process.stderr.write(
    "未找到 edge 入口：需要 bin/edge.mjs（独立包）或 monorepo 下 pnpm install 后的 backend。\n",
  );
  process.exit(1);
}

const root = findInstallRoot();
const res = runPrepare(root);
if (res.error) {
  process.stderr.write(`${res.error.message}\n`);
  process.exit(1);
}
if (res.status !== 0) {
  process.stderr.write(res.stderr || res.stdout || "edge 配置准备失败\n");
  process.exit(res.status ?? 1);
}
process.stdout.write(res.stdout);
