import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/sync-storage-repo.mjs', import.meta.url));

async function makeStorageFixture() {
  const path = await mkdtemp(join(tmpdir(), 'cha-amu-storage-sync-'));
  await Promise.all([
    mkdir(join(path, 'posts'), { recursive: true }),
    mkdir(join(path, 'assets'), { recursive: true })
  ]);
  return path;
}

function runSync(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: '',
        STORAGE_SYNC_DRY_RUN: '0',
        STORAGE_SYNC_MODE: 'latest',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('sync sends every action through the Worker API with service authentication', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push({
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        method: request.method,
        path: request.url,
        payload
      });

      const data = payload.action === 'admin.login' ? { token: 'test-admin-token' } : [];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();

  try {
    const result = await runSync({
      ADMIN_PASSWORD: 'test-admin-password',
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: 'test-storage-secret',
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.map(({ payload }) => payload.action), [
      'admin.login',
      'admin.post.list',
      'admin.assetOverride.list'
    ]);
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.path, '/api');
      assert.equal(request.authorization, 'Bearer test-storage-secret');
      assert.equal(request.contentType, 'text/plain;charset=utf-8');
    }
    assert.equal(requests[1].payload.token, 'test-admin-token');
    assert.equal(requests[2].payload.token, 'test-admin-token');
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync fails before making a request when the service secret is missing', async () => {
  const storagePath = await makeStorageFixture();
  try {
    const result = await runSync({
      ADMIN_PASSWORD: 'test-admin-password',
      API_URL: 'https://cha-amu-gateway.yiyaaang.workers.dev/api',
      STORAGE_SYNC_SECRET: '',
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /STORAGE_SYNC_SECRET is required/);
  } finally {
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync fails before making a request when the admin password is missing', async () => {
  const storagePath = await makeStorageFixture();
  try {
    const result = await runSync({
      ADMIN_PASSWORD: '',
      API_URL: 'https://cha-amu-gateway.yiyaaang.workers.dev/api',
      STORAGE_SYNC_SECRET: 'test-storage-secret',
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ADMIN_PASSWORD is required/);
  } finally {
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync rejects a direct Apps Script endpoint', async () => {
  const storagePath = await makeStorageFixture();
  try {
    const result = await runSync({
      ADMIN_PASSWORD: 'test-admin-password',
      API_URL: 'https://script.google.com/macros/s/example/exec',
      STORAGE_SYNC_SECRET: 'test-storage-secret',
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /exact Worker \/api endpoint/);
  } finally {
    await rm(storagePath, { recursive: true, force: true });
  }
});
