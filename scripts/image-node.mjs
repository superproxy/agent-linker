#!/usr/bin/env node
/**
 * 构建 Docker 聚合镜像 linkagent-node:local。
 * 先打原始 code-server 镜像，再把 dist/linkagent-node 放进同一容器。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
run(pnpm, ['build:dist:node']);
run(pnpm, ['image:code-server']);

const ctx = mkdtempSync(join(tmpdir(), 'linkagent-node-image-'));
try {
  cpSync(join(repo, 'dist', 'linkagent-node'), join(ctx, 'linkagent-node'), { recursive: true });
  mkdirSync(join(ctx, 'code-server'), { recursive: true });
  cpSync(join(repo, 'code-server', 'render-frpc.mjs'), join(ctx, 'code-server', 'render-frpc.mjs'));
  cpSync(join(repo, 'code-server', 'entrypoint-bundle.sh'), join(ctx, 'code-server', 'entrypoint-bundle.sh'));
  run('docker', [
    'build',
    '-f', join(repo, 'code-server', 'Dockerfile.bundle'),
    '-t', 'linkagent-node:local',
    ctx,
  ]);
} finally {
  rmSync(ctx, { recursive: true, force: true });
}
