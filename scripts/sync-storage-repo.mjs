import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';

const STORAGE_WORKDIR = process.env.STORAGE_WORKDIR || '.';
const STORAGE_BASE_URL = (process.env.STORAGE_BASE_URL || 'https://cha-amu.github.io/storage').replace(/\/$/, '');
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SYNC_MODE = process.env.STORAGE_SYNC_MODE || (process.env.GITHUB_EVENT_NAME === 'push' ? 'storage-first' : 'latest');

const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp']);
const ASSET_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf', '.zip', '.txt', '.md', '.json', '.csv', '.mp3', '.mp4', '.webm']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function appsRequest(action, payload = {}) {
  assert(APPS_SCRIPT_URL, 'APPS_SCRIPT_URL is required.');
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload })
  });
  if (!response.ok) throw new Error(`Apps Script request failed: ${response.status}`);
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || `Apps Script action failed: ${action}`);
  return json.data;
}

async function login() {
  assert(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required for storage sync.');
  const session = await appsRequest('admin.login', { password: ADMIN_PASSWORD });
  assert(session && session.token, 'Apps Script did not return an admin token.');
  return session.token;
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

async function scanStorageAssets() {
  const files = (await walk(join(STORAGE_WORKDIR, 'assets'))).filter((file) => ASSET_EXTENSIONS.has(extname(file).toLowerCase()));
  const assets = [];
  for (const file of files) {
    const path = relative(STORAGE_WORKDIR, file).replace(/\\/g, '/');
    const ext = extname(file).toLowerCase();
    const kind = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
    const info = await stat(file);
    const fileName = basename(file);
    assets.push({
      id: `asset:${path}`,
      path,
      url: storageUrl(path),
      kind,
      fileName,
      title: fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
      tags: path.split('/').slice(1, -1).filter(Boolean),
      status: 'visible',
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      contentHash: hash(await readFile(file))
    });
  }
  return assets.sort((a, b) => a.path.localeCompare(b.path));
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

async function syncStoragePostToSheet(token, post) {
  await appsRequest('admin.post.syncFromStorage', {
    token,
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
  assert(existsSync(STORAGE_WORKDIR), `Storage checkout not found: ${STORAGE_WORKDIR}`);
  const token = await login();

  const sheetPosts = await appsRequest('admin.post.list', { token });
  const sheetOverrides = await appsRequest('admin.assetOverride.list', { token });

  let posts = await scanStoragePosts();
  const storageById = new Map(posts.map((post) => [String(post.id), post]));
  const storageByPath = new Map(posts.map((post) => [String(post.path), post]));

  if (SYNC_MODE !== 'storage-first') {
    for (const post of sheetPosts.filter((post) => post && post.status !== 'deleted' && post.body)) {
      const storagePost = storageById.get(String(post.id)) || storageByPath.get(String(post.storagePath || ''));
      if (!storagePost || isSheetNewer(post, storagePost)) {
        await ensureStoragePostForSheetPost(post);
      }
    }
  }

  posts = await scanStoragePosts();
  const assets = await scanStorageAssets();
  const sheetPostsById = new Map(sheetPosts.map((post) => [String(post.id), post]));
  const sheetAssetIds = new Set(sheetOverrides.map((override) => String(override.assetId)));

  for (const post of posts) {
    const sheetPost = sheetPostsById.get(String(post.id));
    if (SYNC_MODE === 'storage-first' || !sheetPost || !isSheetNewer(sheetPost, post)) await syncStoragePostToSheet(token, post);
  }

  for (const asset of assets) {
    if (sheetAssetIds.has(asset.id)) continue;
    await appsRequest('admin.assetOverride.save', {
      token,
      override: {
        assetId: asset.id,
        displayName: asset.title,
        tags: asset.tags,
        status: 'visible',
        source: 'storage',
        storagePath: asset.path,
        fileUrl: asset.url,
        syncStatus: 'linked'
      }
    });
  }

  const generatedAt = new Date().toISOString();
  const manifestPosts = posts.map(manifestPost);
  await writeManifest('manifests/posts.json', { version: 1, generatedAt, posts: manifestPosts });
  await writeManifest('manifests/assets.json', { version: 1, generatedAt, assets });
  await writeManifest('manifest.json', { version: 1, generatedAt, posts: manifestPosts, assets });

  console.log(`Synced ${posts.length} storage posts and ${assets.length} storage assets in ${SYNC_MODE} mode.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
