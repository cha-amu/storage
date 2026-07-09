import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';

const STORAGE_WORKDIR = process.env.STORAGE_WORKDIR || '.';
const STORAGE_BASE_URL = (process.env.STORAGE_BASE_URL || 'https://cha-amu.github.io/storage').replace(/\/$/, '');
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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
    `tags: ${yamlValue(post.tags || [])}`,
    `status: ${yamlValue(post.status || 'published')}`,
    post.excerpt ? `excerpt: ${yamlValue(post.excerpt)}` : '',
    '---'
  ].filter(Boolean).join('\n');
  return `${header}\n\n${post.body || ''}`.trimEnd() + '\n';
}

async function ensureStoragePostForSheetPost(post) {
  if (post.storagePath) return post.storagePath;
  const year = String(post.publishedAt || post.createdAt || new Date().toISOString()).slice(0, 4) || 'undated';
  const slug = slugify(post.slug || post.title || post.id);
  const path = `posts/${year}/${slug}.md`;
  const fullPath = join(STORAGE_WORKDIR, path);
  if (existsSync(fullPath)) return path;
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
      tags: parseTags(meta.tags),
      status: meta.status || 'published',
      createdAt: meta.createdAt || meta.date || '',
      updatedAt: meta.updatedAt || '',
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

async function main() {
  assert(existsSync(STORAGE_WORKDIR), `Storage checkout not found: ${STORAGE_WORKDIR}`);
  const token = await login();

  const sheetPosts = await appsRequest('admin.post.list', { token });
  const sheetOverrides = await appsRequest('admin.assetOverride.list', { token });

  for (const post of sheetPosts.filter((post) => post && post.status !== 'deleted' && post.body)) {
    await ensureStoragePostForSheetPost(post);
  }

  const posts = await scanStoragePosts();
  const assets = await scanStorageAssets();
  const sheetPostIds = new Set(sheetPosts.map((post) => String(post.id)));
  const sheetAssetIds = new Set(sheetOverrides.map((override) => String(override.assetId)));

  for (const post of posts) {
    if (sheetPostIds.has(post.id)) continue;
    await appsRequest('admin.post.save', {
      token,
      post: {
        id: post.id,
        title: post.title,
        excerpt: post.excerpt,
        body: '',
        tags: post.tags,
        status: post.status,
        createdAt: post.createdAt || new Date().toISOString(),
        publishedAt: post.publishedAt || post.createdAt || new Date().toISOString(),
        source: 'storage',
        storagePath: post.path,
        bodyUrl: post.url,
        syncStatus: 'linked'
      }
    });
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
  await writeManifest('manifests/posts.json', { version: 1, generatedAt, posts });
  await writeManifest('manifests/assets.json', { version: 1, generatedAt, assets });
  await writeManifest('manifest.json', { version: 1, generatedAt, posts, assets });

  console.log(`Synced ${posts.length} storage posts and ${assets.length} storage assets.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
