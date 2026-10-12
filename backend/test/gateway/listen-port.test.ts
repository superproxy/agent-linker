import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  effectiveGatewayPort,
  gatewayClientHost,
  persistGatewayListenPort,
  readGatewayListenPort,
  resolveGatewayListenPort,
} from '../../src/gateway/listen-port.js';

function listenEphemeral(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (!port) {
        server.close();
        reject(new Error('no port'));
        return;
      }
      resolve({
        port,
        close: () =>
          new Promise((r, j) => {
            server.close((err) => (err ? j(err) : r()));
          }),
      });
    });
  });
}

test('resolveGatewayListenPort：首选端口空闲时沿用', async () => {
  const ep = await listenEphemeral('127.0.0.1');
  await ep.close();
  const port = await resolveGatewayListenPort('127.0.0.1', ep.port);
  assert.equal(port, ep.port);
});

test('resolveGatewayListenPort：占用时换随机端口', async () => {
  const holder = await listenEphemeral('127.0.0.1');
  try {
    const port = await resolveGatewayListenPort('127.0.0.1', holder.port);
    assert.notEqual(port, holder.port);
    assert.ok(port >= holder.port && port <= holder.port + 4096);
  } finally {
    await holder.close();
  }
});

test('gatewayClientHost：0.0.0.0 映射为 127.0.0.1', () => {
  assert.equal(gatewayClientHost('0.0.0.0'), '127.0.0.1');
  assert.equal(gatewayClientHost('127.0.0.1'), '127.0.0.1');
});

test('persist / read / effectiveGatewayPort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-port-'));
  persistGatewayListenPort(dir, { port: 9123, configuredPort: 8787, pid: 42, at: Date.now() });
  const rec = readGatewayListenPort(dir);
  assert.equal(rec?.port, 9123);
  assert.equal(effectiveGatewayPort(dir, 8787, 42), 9123);
  assert.equal(effectiveGatewayPort(dir, 8787, 99), 8787);
});
