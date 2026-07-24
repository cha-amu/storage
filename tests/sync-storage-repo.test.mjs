import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/sync-storage-repo.mjs', import.meta.url));
const WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/sync.yml', import.meta.url));
const TEST_SYNC_SECRET = 'test-storage-sync-secret-000000000000';

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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function writePost(storagePath, relativePath, id, body = 'Body') {
  const fullPath = join(storagePath, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `---\nid: ${JSON.stringify(id)}\ntitle: "Test"\ndate: "2026-07-12T00:00:00.000Z"\nstatus: "published"\n---\n\n${body}\n`);
  return fullPath;
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

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: [] }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  await writePost(storagePath, 'posts/2026/service-contract.md', 'service-contract');
  await mkdir(join(storagePath, 'assets/files/2026'), { recursive: true });
  await writeFile(join(storagePath, 'assets/files/2026/service-contract.txt'), 'service contract');
  await writeFile(join(storagePath, 'assets/files/2026/split-archive.z01'), 'split archive part');

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.map(({ payload }) => payload.action), [
      'storage.sync.post.list',
      'storage.sync.assetOverride.list',
      'storage.sync.postDeletion.list',
      'storage.sync.post.save',
      'storage.sync.assetOverride.save',
      'storage.sync.assetOverride.save'
    ]);
    assert.deepEqual(
      requests
        .filter(({ payload }) => payload.action === 'storage.sync.assetOverride.save')
        .map(({ payload }) => payload.override.assetId)
        .sort(),
      [
        'asset:assets/files/2026/service-contract.txt',
        'asset:assets/files/2026/split-archive.z01'
      ]
    );
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.path, '/api');
      assert.equal(request.authorization, `Bearer ${TEST_SYNC_SECRET}`);
      assert.equal(request.contentType, 'text/plain;charset=utf-8');
      assert.equal('password' in request.payload, false);
      assert.equal('token' in request.payload, false);
    }
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('date-only posts use the file commit time as their precise updatedAt', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: [] }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  const postPath = join(storagePath, 'posts/2026/date-only.md');
  await mkdir(dirname(postPath), { recursive: true });
  await writeFile(postPath, [
    '---',
    'title: "Date only"',
    'date: "2026-07-12"',
    'status: "published"',
    '---',
    '',
    'Body',
    ''
  ].join('\n'));
  const commitTime = '2026-07-12T11:27:32.000Z';
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_DATE: commitTime,
    GIT_COMMITTER_DATE: commitTime
  };
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Storage Test'],
    ['config', 'user.email', 'storage-test@example.com'],
    ['add', '.'],
    ['commit', '-m', 'Add date-only post']
  ]) {
    const git = spawnSync('git', args, { cwd: storagePath, env: gitEnv, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(storagePath, 'manifests/posts.json'), 'utf8'));
    assert.equal(manifest.posts[0].publishedAt, '2026-07-12');
    assert.equal(manifest.posts[0].updatedAt, commitTime);
    const saveRequest = requests.find((payload) => payload.action === 'storage.sync.post.save');
    assert.equal(saveRequest.post.updatedAt, commitTime);
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('push sync detects changed non-ASCII paths and uses the file commit time', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: [] }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  const postPath = join(storagePath, 'posts/2026/변경된-글.md');
  await mkdir(dirname(postPath), { recursive: true });
  await writeFile(postPath, [
    '---',
    'title: "Changed"',
    'date: "2026-07-12T10:00:00.000Z"',
    'updatedAt: "2026-07-12T10:00:00.000Z"',
    'status: "published"',
    '---',
    '',
    'Original',
    ''
  ].join('\n'));
  const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-07-12T10:00:00.000Z', GIT_COMMITTER_DATE: '2026-07-12T10:00:00.000Z' };
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Storage Test'],
    ['config', 'user.email', 'storage-test@example.com'],
    ['add', '.'],
    ['commit', '-m', 'Add post']
  ]) {
    const git = spawnSync('git', args, { cwd: storagePath, env: gitEnv, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  await writeFile(postPath, (await readFile(postPath, 'utf8')).replace('Original', 'Edited'));
  const commitTime = '2026-07-12T12:15:00.000Z';
  const changedEnv = { ...process.env, GIT_AUTHOR_DATE: commitTime, GIT_COMMITTER_DATE: commitTime };
  for (const args of [['add', '.'], ['commit', '-m', 'Edit post']]) {
    const git = spawnSync('git', args, { cwd: storagePath, env: changedEnv, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      GITHUB_EVENT_NAME: 'push',
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    const saveRequest = requests.find((payload) => payload.action === 'storage.sync.post.save');
    assert.equal(saveRequest.post.updatedAt, commitTime);
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('post deletion removes the file first and finalizes id plus nonce only on a later run', async () => {
  const requests = [];
  const deletion = { id: 'post-delete-me', nonce: 'delete-nonce', storagePath: 'posts/2026/delete-me.md' };
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      let data = [];
      if (payload.action === 'storage.sync.post.list') {
        data = [{ id: deletion.id, status: 'published', body: 'Must not be recreated', storagePath: deletion.storagePath }];
      }
      if (payload.action === 'storage.sync.postDeletion.list') data = { deletions: [deletion] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  const postPath = await writePost(storagePath, deletion.storagePath, deletion.id);
  const env = {
    API_URL: `http://127.0.0.1:${port}/api`,
    STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
    STORAGE_WORKDIR: storagePath
  };

  try {
    const firstRun = await runSync(env);
    assert.equal(firstRun.code, 0, firstRun.stderr);
    assert.equal(await pathExists(postPath), false);
    assert.equal(requests.some((payload) => payload.action === 'storage.sync.postDeletion.finalize'), false);
    const firstManifest = JSON.parse(await readFile(join(storagePath, 'manifests/posts.json'), 'utf8'));
    assert.deepEqual(firstManifest.posts, []);

    const secondRun = await runSync(env);
    assert.equal(secondRun.code, 0, secondRun.stderr);
    assert.equal(await pathExists(postPath), false);
    const finalizeRequests = requests.filter((payload) => payload.action === 'storage.sync.postDeletion.finalize');
    assert.deepEqual(finalizeRequests.map((payload) => payload.deletions), [[{ id: deletion.id, nonce: deletion.nonce }]]);
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('post deletion rejects unsafe paths and id mismatches without deleting or finalizing', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      let data = [];
      if (payload.action === 'storage.sync.postDeletion.list') {
        data = [
          { id: 'unsafe-post', nonce: 'unsafe-nonce', storagePath: 'posts/../outside.md' },
          { id: 'wrong-id', nonce: 'mismatch-nonce', storagePath: 'posts/2026/keep.md' }
        ];
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  const outsidePath = await writePost(storagePath, 'outside.md', 'unsafe-post');
  const keptPath = await writePost(storagePath, 'posts/2026/keep.md', 'actual-id');

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /unsafe storagePath/);
    assert.match(result.stderr, /mismatched id/);
    assert.equal(await pathExists(outsidePath), true);
    assert.equal(await pathExists(keptPath), true);
    assert.equal(requests.some((payload) => payload.action === 'storage.sync.postDeletion.finalize'), false);
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('post deletion finalization batches at most one hundred id and nonce pairs', async () => {
  const requests = [];
  const deletions = Array.from({ length: 205 }, (_, index) => ({
    id: `missing-post-${index}`,
    nonce: `delete-nonce-${index}`,
    storagePath: `posts/2026/missing-post-${index}.md`
  }));
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      let data = [];
      if (payload.action === 'storage.sync.postDeletion.list') data = deletions;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  await mkdir(join(storagePath, 'manifests'), { recursive: true });
  await writeFile(join(storagePath, 'manifests/posts.json'), '{"version":1,"posts":[]}\n');

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    const finalizeRequests = requests.filter((payload) => payload.action === 'storage.sync.postDeletion.finalize');
    assert.deepEqual(finalizeRequests.map((payload) => payload.deletions.length), [100, 100, 5]);
    assert.deepEqual(finalizeRequests.flatMap((payload) => payload.deletions), deletions.map(({ id, nonce }) => ({ id, nonce })));
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('orphan asset overrides are deleted in batches while real asset sidecars remain metadata', async () => {
  const requests = [];
  const keptAssetId = 'asset:assets/gallery/photo.png';
  const orphanIds = ['asset:assets/gallery/photo.md', ...Array.from({ length: 204 }, (_, index) => `asset:assets/orphan-${index}.png`)];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      let data = [];
      if (payload.action === 'storage.sync.assetOverride.list') {
        data = [{ assetId: keptAssetId }, ...orphanIds.map((assetId) => ({ assetId }))];
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  const assetPath = join(storagePath, 'assets/gallery/photo.png');
  const sidecarPath = join(storagePath, 'assets/gallery/photo.md');
  await Promise.all([
    mkdir(join(storagePath, 'assets/gallery'), { recursive: true }),
    mkdir(join(storagePath, 'manifests'), { recursive: true })
  ]);
  await writeFile(join(storagePath, 'manifests/assets.json'), '{"version":1,"assets":[]}\n');
  await writeFile(assetPath, 'not-a-real-png');
  await writeFile(sidecarPath, '---\ntitle: "Sidecar title"\ntags: ["sidecar"]\n---\n\nSidecar description\n');

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    const deleteRequests = requests.filter((payload) => payload.action === 'storage.sync.assetOverride.delete');
    assert.deepEqual(deleteRequests.map((payload) => payload.ids.length), [100, 100, 5]);
    assert.deepEqual(deleteRequests.flatMap((payload) => payload.ids).sort(), [...orphanIds].sort());
    assert.equal(await pathExists(assetPath), true);
    assert.equal(await pathExists(sidecarPath), true);
    const manifest = JSON.parse(await readFile(join(storagePath, 'manifests/assets.json'), 'utf8'));
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0].id, keptAssetId);
    assert.equal(manifest.assets[0].metadataPath, 'assets/gallery/photo.md');
    assert.equal(manifest.assets[0].title, 'Sidecar title');
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('unknown previous asset manifests never trigger destructive override cleanup', async () => {
  const requests = [];
  const orphanId = 'asset:assets/removed.png';
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      let data = [];
      if (payload.action === 'storage.sync.assetOverride.list') data = [{ assetId: orphanId, status: 'hidden' }];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);

  try {
    for (const manifestContents of [null, '{not-json', '{"assets":[{}]}']) {
      const storagePath = await makeStorageFixture();
      await mkdir(join(storagePath, 'manifests'), { recursive: true });
      if (manifestContents !== null) {
        await writeFile(join(storagePath, 'manifests/assets.json'), manifestContents);
      }
      const requestStart = requests.length;

      const result = await runSync({
        API_URL: `http://127.0.0.1:${port}/api`,
        STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
        STORAGE_WORKDIR: storagePath
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        requests.slice(requestStart).some((payload) => payload.action === 'storage.sync.assetOverride.delete'),
        false
      );
      const replacement = JSON.parse(await readFile(join(storagePath, 'manifests/assets.json'), 'utf8'));
      assert.deepEqual(replacement.assets, []);
      await rm(storagePath, { recursive: true, force: true });
    }
  } finally {
    await close(server);
  }
});

test('an orphaned known sidecar is not promoted while standalone Markdown remains an asset', async () => {
  const requests = [];
  const removedAssetId = 'asset:assets/gallery/photo.png';
  const orphanedSidecarId = 'asset:assets/gallery/photo.md';
  const standaloneAssetId = 'asset:assets/notes/readme.md';
  const overrideIds = new Set([removedAssetId, orphanedSidecarId, standaloneAssetId]);
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      let data = [];
      if (payload.action === 'storage.sync.assetOverride.list') {
        data = Array.from(overrideIds, (assetId) => ({ assetId }));
      }
      if (payload.action === 'storage.sync.assetOverride.delete') {
        payload.ids.forEach((assetId) => overrideIds.delete(assetId));
        data = { deletedIds: payload.ids };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  const orphanedSidecarPath = join(storagePath, 'assets/gallery/photo.md');
  const standalonePath = join(storagePath, 'assets/notes/readme.md');
  await Promise.all([
    mkdir(dirname(orphanedSidecarPath), { recursive: true }),
    mkdir(dirname(standalonePath), { recursive: true }),
    mkdir(join(storagePath, 'manifests'), { recursive: true })
  ]);
  await writeFile(orphanedSidecarPath, '---\ntitle: "Old photo metadata"\n---\n\nMust not become an asset.\n');
  await writeFile(standalonePath, '---\ntitle: "Independent note"\n---\n\nKeep this asset.\n');
  await writeFile(join(storagePath, 'manifests/assets.json'), `${JSON.stringify({
    version: 1,
    assets: [
      {
        id: removedAssetId,
        path: 'assets/gallery/photo.png',
        metadataPath: 'assets/gallery/photo.md'
      },
      {
        id: standaloneAssetId,
        path: 'assets/notes/readme.md'
      }
    ]
  }, null, 2)}\n`);

  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 0, result.stderr);
    const firstManifest = JSON.parse(await readFile(join(storagePath, 'manifests/assets.json'), 'utf8'));
    assert.deepEqual(firstManifest.assets.map((asset) => asset.id), [standaloneAssetId]);
    assert.deepEqual(firstManifest.orphanedMetadataPaths, ['assets/gallery/photo.md']);
    const firstDeleteRequests = requests.filter((payload) => payload.action === 'storage.sync.assetOverride.delete');
    assert.deepEqual(firstDeleteRequests.flatMap((payload) => payload.ids), [orphanedSidecarId]);
    assert.equal(overrideIds.has(removedAssetId), true);

    const secondResult = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(secondResult.code, 0, secondResult.stderr);
    const secondManifest = JSON.parse(await readFile(join(storagePath, 'manifests/assets.json'), 'utf8'));
    assert.deepEqual(secondManifest.assets.map((asset) => asset.id), [standaloneAssetId]);
    assert.deepEqual(secondManifest.orphanedMetadataPaths, ['assets/gallery/photo.md']);
    const deleteRequests = requests.filter((payload) => payload.action === 'storage.sync.assetOverride.delete');
    assert.deepEqual(deleteRequests.flatMap((payload) => payload.ids).sort(), [orphanedSidecarId, removedAssetId].sort());
    assert.equal(overrideIds.has(removedAssetId), false);
    assert.equal(await pathExists(orphanedSidecarPath), true);
    assert.equal(await pathExists(standalonePath), true);
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync fails closed before API requests when the storage layout is incomplete', async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'unexpected request' }));
  });
  const port = await listen(server);
  const missingAssetsPath = await mkdtemp(join(tmpdir(), 'cha-amu-storage-missing-assets-'));
  const invalidAssetsPath = await mkdtemp(join(tmpdir(), 'cha-amu-storage-invalid-assets-'));
  const missingCheckoutPath = join(missingAssetsPath, 'missing-checkout');
  await writeFile(join(invalidAssetsPath, 'assets'), 'not a directory');

  try {
    for (const [storagePath, expectedError] of [
      [missingCheckoutPath, /Storage checkout not found/],
      [missingAssetsPath, /Storage assets directory not found/],
      [invalidAssetsPath, /Storage assets path is not a directory/]
    ]) {
      const result = await runSync({
        API_URL: `http://127.0.0.1:${port}/api`,
        STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
        STORAGE_WORKDIR: storagePath
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, expectedError);
    }
    assert.equal(requestCount, 0);
  } finally {
    await close(server);
    await Promise.all([
      rm(missingAssetsPath, { recursive: true, force: true }),
      rm(invalidAssetsPath, { recursive: true, force: true })
    ]);
  }
});

test('sync fails before making a request when the service secret is missing', async () => {
  const storagePath = await makeStorageFixture();
  try {
    const result = await runSync({
      API_URL: 'https://cha-amu-gateway.cha-amu.workers.dev/api',
      STORAGE_SYNC_SECRET: '',
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /STORAGE_SYNC_SECRET must be at least 32 characters/);
  } finally {
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync stops on a rejected service secret without writing manifests or leaking the secret', async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    request.on('end', () => {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Storage authentication failed.' }));
    });
  });
  const port = await listen(server);
  const storagePath = await makeStorageFixture();
  try {
    const result = await runSync({
      API_URL: `http://127.0.0.1:${port}/api`,
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Storage authentication failed/);
    assert.equal(result.stderr.includes(TEST_SYNC_SECRET), false);
    assert.equal(requestCount, 1);
    assert.equal(await pathExists(join(storagePath, 'manifests/posts.json')), false);
    assert.equal(await pathExists(join(storagePath, 'manifests/assets.json')), false);
  } finally {
    await close(server);
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync rejects a direct Apps Script endpoint', async () => {
  const storagePath = await makeStorageFixture();
  try {
    const result = await runSync({
      API_URL: 'https://script.google.com/macros/s/example/exec',
      STORAGE_SYNC_SECRET: TEST_SYNC_SECRET,
      STORAGE_WORKDIR: storagePath
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /exact Worker \/api endpoint/);
  } finally {
    await rm(storagePath, { recursive: true, force: true });
  }
});

test('sync client and workflow have no administrator credential dependency', async () => {
  const [script, workflow] = await Promise.all([
    readFile(SCRIPT_PATH, 'utf8'),
    readFile(WORKFLOW_PATH, 'utf8')
  ]);
  for (const contents of [script, workflow]) {
    assert.equal(contents.includes('ADMIN_PASSWORD'), false);
    assert.equal(contents.includes('admin.login'), false);
    assert.equal(contents.includes('admin.session.refresh'), false);
  }
  assert.match(workflow, /STORAGE_SYNC_SECRET:\s*\$\{\{ secrets\.STORAGE_SYNC_SECRET \}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
});
