import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const STORAGE_WORKDIR = process.env.STORAGE_WORKDIR || '.';
const STORAGE_BASE_URL = (process.env.STORAGE_BASE_URL || 'https://cha-amu.github.io/storage').replace(/\/$/, '');
const DEFAULT_API_URL = 'https://cha-amu-gateway.cha-amu.workers.dev/api';
const API_URL = (process.env.API_URL || DEFAULT_API_URL).trim();
const STORAGE_SYNC_SECRET = process.env.STORAGE_SYNC_SECRET || '';
const DRY_RUN = process.env.STORAGE_SYNC_DRY_RUN === '1';
const ADMIN_MUTATION_BATCH_SIZE = 100;

const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp']);
const ASSET_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf', '.zip', '.txt', '.md', '.json', '.csv', '.mp3', '.mp4', '.webm']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSyncConfiguration() {
  let url;
  try {
    url = new URL(API_URL);
  } catch (_) {
    throw new Error('API_URL must be a valid URL.');
  }

  const localTestHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && localTestHost), 'API_URL must use HTTPS.');
  assert(url.pathname === '/api' && !url.search && !url.hash, 'API_URL must point to the exact Worker /api endpoint.');
  assert(!url.username && !url.password, 'API_URL must not contain credentials.');
  assert(STORAGE_SYNC_SECRET.length >= 32, 'STORAGE_SYNC_SECRET must be at least 32 characters for storage sync.');
}

async function assertStorageLayout() {
  let checkoutInfo;
  try {
    checkoutInfo = await stat(STORAGE_WORKDIR);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`Storage checkout not found: ${STORAGE_WORKDIR}`);
    }
    throw error;
  }
  assert(checkoutInfo.isDirectory(), `Storage checkout is not a directory: ${STORAGE_WORKDIR}`);

  const assetsRoot = resolve(STORAGE_WORKDIR, 'assets');
  let assetsInfo;
  try {
    assetsInfo = await stat(assetsRoot);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`Storage assets directory not found: ${assetsRoot}`);
    }
    throw error;
  }
  assert(assetsInfo.isDirectory(), `Storage assets path is not a directory: ${assetsRoot}`);
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map((tag) => tag.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return text.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function assetStatus(value) {
  return value === 'hidden' || value === 'deleted' || value === 'visible' ? value : 'visible';
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function displayText(value) {
  return String(value || '').replace(/[_]+/g, ' ').trim();
}

function filenameMetadata(fileName) {
  const stem = basename(fileName, extname(fileName));
  const segments = stem.split('--');
  if (segments.length === 1) {
    return {
      title: displayText(stem.replace(/[-]+/g, ' ')),
      tags: [],
      description: ''
    };
  }

  const [title = '', tagText = '', ...descriptionParts] = segments;
  return {
    title: displayText(title),
    tags: tagText.split('+').map(displayText).filter(Boolean),
    description: displayText(descriptionParts.join('--'))
  };
}

function parseFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, body: markdown };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: markdown };
  const meta = {};
  for (const line of normalized.slice(4, end).trim().split('\n')) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) meta[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: normalized.slice(end + 4).replace(/^\n+/, '') };
}

function excerpt(value, maxLength = 120) {
  const compact = String(value || '').replace(/[#>*_`\-[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength).trim()}...`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readManifestState(paths, collectionKey) {
  for (const path of paths) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const records = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest[collectionKey] : null;
      const validRecords = Array.isArray(records) && records.every((record) => (
        record && typeof record === 'object' && !Array.isArray(record) && typeof record.id === 'string' && record.id.trim()
      ));
      if (validRecords) return { known: true, manifest };
    } catch (_) {
      // Try the combined manifest before treating prior state as unknown.
    }
  }
  return { known: false, manifest: { [collectionKey]: [] } };
}

function changedPaths() {
  if (process.env.GITHUB_EVENT_NAME !== 'push') return undefined;
  try {
    return new Set(
      execFileSync('git', ['diff', '--name-only', '-z', 'HEAD~1', 'HEAD'], { cwd: STORAGE_WORKDIR, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
    );
  } catch (_) {
    return null;
  }
}

function pathChanged(changes, path) {
  if (changes === null) return true;
  return Boolean(changes && changes.has(path));
}

function timeValue(value) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? time : 0;
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function fileCommitTimestamp(path) {
  try {
    const value = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], {
      cwd: STORAGE_WORKDIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const time = timeValue(value);
    return time ? new Date(time).toISOString() : '';
  } catch (_) {
    return '';
  }
}

function storagePostUpdatedAt(meta, path, changes) {
  const committedAt = fileCommitTimestamp(path);
  if (pathChanged(changes, path) && committedAt) return committedAt;
  if (meta.updatedAt && !isDateOnly(meta.updatedAt)) return meta.updatedAt;
  return committedAt || meta.updatedAt || meta.publishedAt || meta.date || '';
}

function storageUrl(path) {
  return `${STORAGE_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

function storageBaseUrlForPath(path) {
  const dir = dirname(path).replace(/\\/g, '/');
  return `${storageUrl(dir === '.' ? '' : dir)}/`;
}

function withoutExtension(file) {
  return file.slice(0, -extname(file).length);
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function batches(items, size = ADMIN_MUTATION_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function deleteOrphanAssetOverrides(overrides, previousAssetIds, assets) {
  const manifestAssetIds = new Set(assets.map((asset) => String(asset.id)));
  const orphanIds = Array.from(new Set(
    overrides
      .map((override) => String(override?.assetId || '').trim())
      .filter((assetId) => assetId && !previousAssetIds.has(assetId) && !manifestAssetIds.has(assetId))
  ));
  for (const ids of batches(orphanIds)) {
    await storageRequest('storage.sync.assetOverride.delete', { ids });
  }
}

async function storageRequest(action, payload = {}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  console.info(JSON.stringify({ event: 'storage_sync_request', phase: 'started', action, request_id: requestId }));
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STORAGE_SYNC_SECRET}`,
      'Content-Type': 'text/plain;charset=utf-8',
      'X-Sync-Request-Id': requestId
    },
    redirect: 'error',
    body: JSON.stringify({ action, ...payload })
  }).catch((error) => {
    console.error(JSON.stringify({ event: 'storage_sync_request', phase: 'network_error', action,
      request_id: requestId, duration_ms: Date.now() - startedAt }));
    throw error;
  });
  let json;
  try {
    json = await response.json();
  } catch (_) {
    console.error(JSON.stringify({ event: 'storage_sync_request', phase: 'invalid_json', action,
      request_id: requestId, status: response.status, duration_ms: Date.now() - startedAt }));
    throw new Error(`Gateway returned an invalid response: ${response.status}`);
  }
  console.info(JSON.stringify({ event: 'storage_sync_request', phase: 'response', action,
    request_id: requestId, status: response.status, duration_ms: Date.now() - startedAt,
    ok: json?.ok === true, data_type: Array.isArray(json?.data) ? 'array' : json?.data === null ? 'null' : typeof json?.data }));
  if (!response.ok || !json.ok) throw new Error(json.error || `Gateway action failed: ${action} (${response.status})`);
  return json.data;
}

async function scanStoragePosts(changes) {
  const files = (await walk(join(STORAGE_WORKDIR, 'posts'))).filter((file) => extname(file).toLowerCase() === '.md');
  const posts = [];
  for (const file of files) {
    const path = relative(STORAGE_WORKDIR, file).replace(/\\/g, '/');
    const markdown = await readFile(file, 'utf8');
    const { meta, body } = parseFrontmatter(markdown);
    const title = meta.title || basename(file, '.md').replace(/[-_]+/g, ' ');
    posts.push({
      id: meta.id || `post:${path}`,
      path,
      url: storageUrl(path),
      title,
      excerpt: meta.excerpt || excerpt(body),
      body,
      tags: parseTags(meta.tags),
      status: meta.status || 'published',
      createdAt: meta.createdAt || meta.date || '',
      updatedAt: storagePostUpdatedAt(meta, path, changes),
      publishedAt: meta.publishedAt || meta.date || '',
      contentHash: hash(markdown)
    });
  }
  return posts.sort((a, b) => String(b.publishedAt || b.createdAt).localeCompare(String(a.publishedAt || a.createdAt)) || a.path.localeCompare(b.path));
}

async function scanStorageAssets(changes = changedPaths()) {
  const previousManifestState = readManifestState([
    join(STORAGE_WORKDIR, 'manifests/assets.json'),
    join(STORAGE_WORKDIR, 'manifest.json')
  ], 'assets');
  const previousManifest = previousManifestState.manifest;
  const previousAssets = Array.isArray(previousManifest.assets) ? previousManifest.assets : [];
  const previousByPath = new Map(previousAssets.map((asset) => [String(asset.path), asset]));
  const previousStandaloneMarkdownPaths = new Set(
    previousAssets
      .map((asset) => String(asset?.path || ''))
      .filter((path) => extname(path).toLowerCase() === '.md')
  );
  const previousMetadataPaths = new Set(
    [
      ...previousAssets.map((asset) => asset?.metadataPath),
      ...(Array.isArray(previousManifest.orphanedMetadataPaths) ? previousManifest.orphanedMetadataPaths : [])
    ]
      .map((path) => String(path || ''))
      .filter((path) => path && !previousStandaloneMarkdownPaths.has(path))
  );
  const allFiles = await walk(join(STORAGE_WORKDIR, 'assets'));
  const assetStems = new Set(
    allFiles
      .filter((file) => {
        const ext = extname(file).toLowerCase();
        return ext !== '.md' && ASSET_EXTENSIONS.has(ext);
      })
      .map(withoutExtension)
  );
  const orphanedMetadataPaths = Array.from(new Set(
    allFiles
      .filter((file) => extname(file).toLowerCase() === '.md' && !assetStems.has(withoutExtension(file)))
      .map((file) => relative(STORAGE_WORKDIR, file).replace(/\\/g, '/'))
      .filter((path) => previousMetadataPaths.has(path))
  )).sort();
  const orphanedMetadataPathSet = new Set(orphanedMetadataPaths);
  const files = allFiles.filter((file) => {
    const ext = extname(file).toLowerCase();
    if (!ASSET_EXTENSIONS.has(ext)) return false;
    if (ext !== '.md') return true;
    if (assetStems.has(withoutExtension(file))) return false;
    const path = relative(STORAGE_WORKDIR, file).replace(/\\/g, '/');
    return !orphanedMetadataPathSet.has(path);
  });
  const assets = [];
  for (const file of files) {
    const path = relative(STORAGE_WORKDIR, file).replace(/\\/g, '/');
    const ext = extname(file).toLowerCase();
    const kind = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
    const info = await stat(file);
    const fileName = basename(file);
    const nameMeta = filenameMetadata(fileName);
    const sidecarPath = ext === '.md' ? '' : `${withoutExtension(file)}.md`;
    const hasSidecar = Boolean(sidecarPath && existsSync(sidecarPath));
    const sidecarText = hasSidecar ? await readFile(sidecarPath, 'utf8') : '';
    const sidecar = hasSidecar ? parseFrontmatter(sidecarText) : { meta: {}, body: '' };
    const sidecarRelativePath = hasSidecar ? relative(STORAGE_WORKDIR, sidecarPath).replace(/\\/g, '/') : '';
    const sidecarInfo = hasSidecar ? await stat(sidecarPath) : null;
    const previous = previousByPath.get(path);
    const unchanged = previous && !pathChanged(changes, path) && (!sidecarRelativePath || !pathChanged(changes, sidecarRelativePath)) && previous.size === info.size;
    const title = sidecar.meta.title || nameMeta.title || nameMeta.description || fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const tags = parseTags(sidecar.meta.tags || nameMeta.tags);
    const description = sidecar.meta.description || sidecar.meta.excerpt || sidecar.body.trim() || nameMeta.description;
    const updatedAt = unchanged && previous.updatedAt ? previous.updatedAt : new Date(Math.max(info.mtime.getTime(), sidecarInfo ? sidecarInfo.mtime.getTime() : 0)).toISOString();
    assets.push({
      id: `asset:${path}`,
      path,
      url: storageUrl(path),
      kind,
      fileName,
      title,
      description: description || undefined,
      tags: tags.length ? tags : path.split('/').slice(1, -1).filter(Boolean),
      sourceUrl: sidecar.meta.sourceUrl || undefined,
      status: assetStatus(sidecar.meta.status),
      sortOrder: sidecar.meta.sortOrder ? numberValue(sidecar.meta.sortOrder) : undefined,
      size: info.size,
      updatedAt,
      metadataPath: sidecarRelativePath || undefined,
      markdownBaseUrl: hasSidecar ? storageBaseUrlForPath(sidecarRelativePath) : undefined,
      markdownRootUrl: STORAGE_BASE_URL
    });
  }
  return {
    assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
    orphanedMetadataPaths,
    previousAssetIds: new Set(previousAssets.map((asset) => String(asset?.id || '')).filter(Boolean)),
    previousManifestKnown: previousManifestState.known
  };
}

async function writeManifest(path, payload) {
  const fullPath = join(STORAGE_WORKDIR, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function manifestPost(post) {
  const { body, ...publicPost } = post;
  return publicPost;
}

// Post files in this repository are the only copy of each post: the site reads them
// directly and their frontmatter status decides what is listed. This job regenerates the
// manifests and registers new assets with the gateway's asset display settings.
async function main() {
  await assertStorageLayout();
  if (!DRY_RUN) {
    assertSyncConfiguration();
  }

  const overrides = DRY_RUN ? [] : await storageRequest('storage.sync.assetOverride.list');
  const changes = changedPaths();
  const posts = await scanStoragePosts(changes);
  const { assets, orphanedMetadataPaths, previousAssetIds, previousManifestKnown } = await scanStorageAssets(changes);
  const overrideAssetIds = new Set(overrides.map((override) => String(override.assetId)));

  for (const asset of assets) {
    if (DRY_RUN) continue;
    if (overrideAssetIds.has(asset.id)) continue;
    await storageRequest('storage.sync.assetOverride.save', {
      override: {
        assetId: asset.id,
        displayName: asset.title,
        description: asset.description,
        tags: asset.tags,
        sourceUrl: asset.sourceUrl,
        status: asset.status,
        sortOrder: asset.sortOrder
      }
    });
  }

  if (!DRY_RUN && previousManifestKnown) {
    await deleteOrphanAssetOverrides(overrides, previousAssetIds, assets);
  }

  const generatedAt = new Date().toISOString();
  const manifestPosts = posts.map(manifestPost);
  await writeManifest('manifests/posts.json', { version: 1, generatedAt, posts: manifestPosts });
  await writeManifest('manifests/assets.json', { version: 1, generatedAt, assets, orphanedMetadataPaths });
  await writeManifest('manifest.json', { version: 1, generatedAt, posts: manifestPosts, assets });

  console.log(`Synced ${posts.length} storage posts and ${assets.length} storage assets${DRY_RUN ? ' (dry run)' : ''}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
