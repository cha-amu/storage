import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const STORAGE_WORKDIR = process.env.STORAGE_WORKDIR || '.';
const STORAGE_BASE_URL = (process.env.STORAGE_BASE_URL || 'https://cha-amu.github.io/storage').replace(/\/$/, '');
const DEFAULT_API_URL = 'https://cha-amu-gateway.yiyaaang.workers.dev/api';
const API_URL = (process.env.API_URL || DEFAULT_API_URL).trim();
const STORAGE_SYNC_SECRET = process.env.STORAGE_SYNC_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SYNC_MODE = process.env.STORAGE_SYNC_MODE || (process.env.GITHUB_EVENT_NAME === 'push' ? 'storage-first' : 'latest');
const DRY_RUN = process.env.STORAGE_SYNC_DRY_RUN === '1';
const ADMIN_SESSION_REFRESH_MS = 20_000;
const ADMIN_MUTATION_BATCH_SIZE = 100;

let adminToken = '';
let adminTokenRefreshedAt = 0;

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
  assert(STORAGE_SYNC_SECRET, 'STORAGE_SYNC_SECRET is required for storage sync.');
  assert(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required for storage sync.');
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

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .toLowerCase() || 'untitled';
}

function yamlValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  return JSON.stringify(String(value ?? ''));
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
      execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: STORAGE_WORKDIR, encoding: 'utf8' })
        .split('\n')
        .map((path) => path.trim())
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

function postTime(post) {
  return timeValue(post.updatedAt || post.publishedAt || post.createdAt);
}

function isSheetNewer(sheetPost, storagePost) {
  return postTime(sheetPost) > postTime(storagePost);
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

function normalizePostDeletions(value) {
  const values = Array.isArray(value) ? value : Array.isArray(value?.deletions) ? value.deletions : [];
  const unique = new Map();
  for (const value of values) {
    const id = String(value?.id || '').trim();
    const nonce = String(value?.nonce || '').trim();
    if (!id || !nonce) continue;
    const storagePath = String(value?.storagePath || '').trim();
    unique.set(`${id}\0${nonce}`, { id, nonce, storagePath });
  }
  return Array.from(unique.values());
}

function validatedPostPath(value) {
  const path = String(value || '').trim();
  if (!path || path.includes('\\') || path.includes('\0') || path !== posix.normalize(path)) return '';
  const segments = path.split('/');
  if (segments.length < 2 || segments[0] !== 'posts' || segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  if (extname(path).toLowerCase() !== '.md') return '';

  const postsRoot = resolve(STORAGE_WORKDIR, 'posts');
  const fullPath = resolve(STORAGE_WORKDIR, ...segments);
  if (fullPath === postsRoot || !fullPath.startsWith(`${postsRoot}${sep}`)) return '';
  return path;
}

async function unlinkValidatedPostPath(path) {
  const postsRoot = await realpath(resolve(STORAGE_WORKDIR, 'posts'));
  const fullPath = resolve(STORAGE_WORKDIR, ...path.split('/'));
  let actualPath;
  try {
    actualPath = await realpath(fullPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (actualPath === postsRoot || !actualPath.startsWith(`${postsRoot}${sep}`)) {
    console.warn(`Skipped post deletion outside the storage posts directory: ${path}.`);
    return;
  }
  await unlink(fullPath);
}

async function consumePostDeletions(deletions, postsAtStart, previousPostIds, previousManifestKnown) {
  const finalizable = [];
  const pendingIds = new Set(deletions.map((deletion) => deletion.id));

  for (const deletion of deletions) {
    const requestedPath = deletion.storagePath ? validatedPostPath(deletion.storagePath) : '';
    if (deletion.storagePath && !requestedPath) {
      console.warn(`Skipped post deletion with unsafe storagePath for ${deletion.id}.`);
      continue;
    }

    const postAtRequestedPath = requestedPath ? postsAtStart.find((post) => post.path === requestedPath) : undefined;
    if (postAtRequestedPath && String(postAtRequestedPath.id) !== deletion.id) {
      console.warn(`Skipped post deletion with mismatched id at ${requestedPath}.`);
      continue;
    }

    const matchingPosts = postsAtStart.filter((post) => String(post.id) === deletion.id);
    const targetPaths = Array.from(new Set(matchingPosts.map((post) => validatedPostPath(post.path)).filter(Boolean)));
    if (targetPaths.length !== new Set(matchingPosts.map((post) => post.path)).size) {
      console.warn(`Skipped post deletion with an unsafe scanned path for ${deletion.id}.`);
      continue;
    }

    if (!targetPaths.length) {
      if (previousManifestKnown && !previousPostIds.has(deletion.id)) {
        finalizable.push({ id: deletion.id, nonce: deletion.nonce });
      }
      continue;
    }

    for (const path of targetPaths) {
      await unlinkValidatedPostPath(path);
    }
  }

  return { finalizable, pendingIds };
}

async function finalizePostDeletions(deletions) {
  for (const batch of batches(deletions)) {
    await adminRequest('admin.postDeletion.finalize', { deletions: batch });
  }
}

async function deleteOrphanAssetOverrides(sheetOverrides, previousAssetIds, assets) {
  const manifestAssetIds = new Set(assets.map((asset) => String(asset.id)));
  const orphanIds = Array.from(new Set(
    sheetOverrides
      .map((override) => String(override?.assetId || '').trim())
      .filter((assetId) => assetId && !previousAssetIds.has(assetId) && !manifestAssetIds.has(assetId))
  ));
  for (const ids of batches(orphanIds)) {
    await adminRequest('admin.assetOverride.delete', { ids });
  }
}

async function gatewayRequest(action, payload = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STORAGE_SYNC_SECRET}`,
      'Content-Type': 'text/plain;charset=utf-8'
    },
    redirect: 'error',
    body: JSON.stringify({ action, ...payload })
  });
  let json;
  try {
    json = await response.json();
  } catch (_) {
    throw new Error(`Gateway returned an invalid response: ${response.status}`);
  }
  if (!response.ok || !json.ok) throw new Error(json.error || `Gateway action failed: ${action} (${response.status})`);
  return json.data;
}

async function login() {
  const session = await gatewayRequest('admin.login', { password: ADMIN_PASSWORD });
  assert(session && session.token, 'Gateway did not return an admin token.');
  adminToken = session.token;
  adminTokenRefreshedAt = Date.now();
}

async function adminRequest(action, payload = {}) {
  assert(adminToken, 'Admin session is required for storage sync.');
  if (Date.now() - adminTokenRefreshedAt >= ADMIN_SESSION_REFRESH_MS) {
    const session = await gatewayRequest('admin.session.refresh', { token: adminToken });
    assert(session && session.token, 'Gateway did not refresh the admin token.');
    adminToken = session.token;
    adminTokenRefreshedAt = Date.now();
  }
  return gatewayRequest(action, { ...payload, token: adminToken });
}

function postMarkdown(post) {
  const date = post.publishedAt || post.createdAt || new Date().toISOString();
  const header = [
    '---',
    `id: ${yamlValue(post.id)}`,
    `title: ${yamlValue(post.title || '(제목 없음)')}`,
    `date: ${yamlValue(date)}`,
    post.createdAt ? `createdAt: ${yamlValue(post.createdAt)}` : '',
    post.updatedAt ? `updatedAt: ${yamlValue(post.updatedAt)}` : '',
    post.publishedAt ? `publishedAt: ${yamlValue(post.publishedAt)}` : '',
    `tags: ${yamlValue(post.tags || [])}`,
    `status: ${yamlValue(post.status || 'published')}`,
    post.excerpt ? `excerpt: ${yamlValue(post.excerpt)}` : '',
    '---'
  ].filter(Boolean).join('\n');
  return `${header}\n\n${post.body || ''}`.trimEnd() + '\n';
}

async function ensureStoragePostForSheetPost(post) {
  const year = String(post.publishedAt || post.createdAt || new Date().toISOString()).slice(0, 4) || 'undated';
  const slug = slugify(post.slug || post.title || post.id);
  const path = post.storagePath || `posts/${year}/${slug}.md`;
  const fullPath = join(STORAGE_WORKDIR, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, postMarkdown(post));
  return path;
}

async function scanStoragePosts() {
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
      updatedAt: meta.updatedAt || meta.publishedAt || meta.date || '',
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

async function syncStoragePostToSheet(post) {
  await adminRequest('admin.post.syncFromStorage', {
    post: {
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      body: post.body,
      tags: post.tags,
      status: post.status,
      createdAt: post.createdAt || new Date().toISOString(),
      updatedAt: post.updatedAt || post.publishedAt || post.createdAt || new Date().toISOString(),
      publishedAt: post.publishedAt || post.createdAt || new Date().toISOString(),
      source: 'storage',
      storagePath: post.path,
      bodyUrl: post.url,
      syncStatus: 'synced'
    }
  });
}

async function main() {
  await assertStorageLayout();
  if (!DRY_RUN) {
    assertSyncConfiguration();
    await login();
  }

  const sheetPosts = DRY_RUN ? [] : await adminRequest('admin.post.list');
  const sheetOverrides = DRY_RUN ? [] : await adminRequest('admin.assetOverride.list');
  const postDeletions = DRY_RUN ? [] : normalizePostDeletions(await adminRequest('admin.postDeletion.list'));
  const changes = changedPaths();

  const previousPostsManifestState = readManifestState([
    join(STORAGE_WORKDIR, 'manifests/posts.json'),
    join(STORAGE_WORKDIR, 'manifest.json')
  ], 'posts');
  const previousPostIds = new Set(
    previousPostsManifestState.manifest.posts.map((post) => String(post?.id || '')).filter(Boolean)
  );
  const postsAtStart = await scanStoragePosts();
  const { finalizable: finalizablePostDeletions, pendingIds: pendingPostDeletionIds } = await consumePostDeletions(
    postDeletions,
    postsAtStart,
    previousPostIds,
    previousPostsManifestState.known
  );
  let posts = await scanStoragePosts();
  const storageById = new Map(posts.map((post) => [String(post.id), post]));
  const storageByPath = new Map(posts.map((post) => [String(post.path), post]));

  if (SYNC_MODE !== 'storage-first') {
    for (const post of sheetPosts.filter((post) => post && !pendingPostDeletionIds.has(String(post.id)) && post.status !== 'deleted' && post.body)) {
      const storagePost = storageById.get(String(post.id)) || storageByPath.get(String(post.storagePath || ''));
      if (!storagePost || isSheetNewer(post, storagePost)) {
        await ensureStoragePostForSheetPost(post);
      }
    }
  }

  posts = await scanStoragePosts();
  const { assets, orphanedMetadataPaths, previousAssetIds, previousManifestKnown: previousAssetsManifestKnown } = await scanStorageAssets(changes);
  const sheetPostsById = new Map(sheetPosts.map((post) => [String(post.id), post]));
  const sheetAssetIds = new Set(sheetOverrides.map((override) => String(override.assetId)));

  for (const post of posts) {
    if (pendingPostDeletionIds.has(String(post.id))) continue;
    const sheetPost = sheetPostsById.get(String(post.id));
    const changedStoragePost = changes === undefined || pathChanged(changes, post.path);
    if (!DRY_RUN && changedStoragePost && (SYNC_MODE === 'storage-first' || !sheetPost || !isSheetNewer(sheetPost, post))) await syncStoragePostToSheet(post);
  }

  for (const asset of assets) {
    if (DRY_RUN) continue;
    if (sheetAssetIds.has(asset.id)) continue;
    await adminRequest('admin.assetOverride.save', {
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

  if (!DRY_RUN && previousAssetsManifestKnown) {
    await deleteOrphanAssetOverrides(sheetOverrides, previousAssetIds, assets);
  }

  const generatedAt = new Date().toISOString();
  const manifestPosts = posts.map(manifestPost);
  await writeManifest('manifests/posts.json', { version: 1, generatedAt, posts: manifestPosts });
  await writeManifest('manifests/assets.json', { version: 1, generatedAt, assets, orphanedMetadataPaths });
  await writeManifest('manifest.json', { version: 1, generatedAt, posts: manifestPosts, assets });

  if (!DRY_RUN) await finalizePostDeletions(finalizablePostDeletions);

  console.log(`Synced ${posts.length} storage posts and ${assets.length} storage assets in ${SYNC_MODE}${DRY_RUN ? ' dry-run' : ''} mode.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
