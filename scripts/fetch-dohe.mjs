// Fetches dohe from the HindiDohe Facebook Page via the Graph API and writes
// public/dohe.json for the app. Runs in GitHub Actions; tokens come only from
// encrypted secrets (environment variables) and are never logged or written.
//
// Env:
//   FB_SYSTEM_USER_TOKEN  token of a Meta Business *system user* assigned to the Page
//                         (preferred; the Page token is derived at runtime), or
//   FB_PAGE_TOKEN         a Page access token (fallback)
//   FB_APP_SECRET         optional; adds appsecret_proof to every call
//   FB_PAGE_ID            default 166579083500816
//   GRAPH_API_VERSION     default v26.0
//   OUTPUT                default public/dohe.json
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MEANING_MARKER = 'अर्थ';

export function appSecretProof(token, secret) {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export class GraphError extends Error {
  constructor(status, err) {
    super(`Graph API error http=${status} code=${err?.code} subcode=${err?.error_subcode} type=${err?.type}: ${err?.message}`);
    this.status = status;
    this.code = err?.code;
  }
}

// Removes secrets from any URL before it could appear in an error message.
export function redact(url) {
  const u = new URL(url);
  for (const k of ['access_token', 'appsecret_proof']) {
    if (u.searchParams.has(k)) u.searchParams.set(k, 'REDACTED');
  }
  return u.toString();
}

export async function graphGet(fetchImpl, url, token, appSecret) {
  const u = new URL(url);
  u.searchParams.set('access_token', token);
  if (appSecret) u.searchParams.set('appsecret_proof', appSecretProof(token, appSecret));
  let res;
  try {
    res = await fetchImpl(u, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Network error calling ${redact(u)}: ${e.message}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Non-JSON response (http=${res.status}) from ${redact(u)}`);
  }
  if (!res.ok || body?.error) throw new GraphError(res.status, body?.error ?? { message: 'unknown' });
  return body;
}

export async function resolvePageToken({ fetchImpl, graph, pageId, systemUserToken, pageToken, appSecret }) {
  if (systemUserToken) {
    const body = await graphGet(fetchImpl, `${graph}/${pageId}?fields=access_token`, systemUserToken, appSecret);
    if (!body.access_token) {
      throw new Error('System user has no access to this Page (no access_token returned). Assign the Page to the system user.');
    }
    return body.access_token;
  }
  if (pageToken) return pageToken;
  throw new Error('No token: set FB_SYSTEM_USER_TOKEN (preferred) or FB_PAGE_TOKEN.');
}

export async function fetchAllPosts({ fetchImpl, graph, pageId, token, appSecret, maxPages = 100 }) {
  const posts = [];
  let next = `${graph}/${pageId}/feed?fields=id,message,created_time,is_published&limit=100`;
  let pages = 0;
  while (next && pages < maxPages) {
    const body = await graphGet(fetchImpl, next, token, appSecret);
    posts.push(...(body.data ?? []));
    pages++;
    const n = body.paging?.next;
    // Facebook's `next` link embeds the token; graphGet re-applies it, so strip it here.
    next = n ? (() => { const u = new URL(n); u.searchParams.delete('access_token'); u.searchParams.delete('appsecret_proof'); return u.toString(); })() : null;
  }
  return posts;
}

export function toDohe(posts) {
  const seen = new Set();
  const dohe = [];
  for (const p of posts) {
    if (p.is_published === false) continue;
    const text = typeof p.message === 'string' ? p.message.trim() : '';
    if (!text.includes(MEANING_MARKER)) continue;
    const key = text.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    dohe.push({ id: String(p.id), created_time: p.created_time ?? '', text });
  }
  dohe.sort((a, b) => (b.created_time ?? '').localeCompare(a.created_time ?? ''));
  return dohe;
}

export function buildDocument(dohe, now = new Date()) {
  return { schema: 1, source: 'facebook-graph-api', updated_at: now.toISOString(), count: dohe.length, dohe };
}

// Returns true when the file content changed (ignores updated_at).
export async function writeIfChanged(path, doc) {
  let old = null;
  try { old = JSON.parse(await readFile(path, 'utf8')); } catch { /* first run */ }
  if (old && JSON.stringify(old.dohe) === JSON.stringify(doc.dohe)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return true;
}

export async function run(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  const graph = `https://graph.facebook.com/${env.GRAPH_API_VERSION || 'v26.0'}`;
  const pageId = env.FB_PAGE_ID || '166579083500816';
  const output = env.OUTPUT || 'public/dohe.json';
  const appSecret = env.FB_APP_SECRET || undefined;
  const token = await resolvePageToken({
    fetchImpl, graph, pageId, appSecret,
    systemUserToken: env.FB_SYSTEM_USER_TOKEN, pageToken: env.FB_PAGE_TOKEN,
  });
  const posts = await fetchAllPosts({ fetchImpl, graph, pageId, token, appSecret });
  const dohe = toDohe(posts);
  // Safety net: never replace good data with an empty list (e.g. permission change).
  if (dohe.length === 0) throw new Error(`Fetched ${posts.length} posts but 0 dohe; keeping the existing ${output}.`);
  const changed = await writeIfChanged(output, buildDocument(dohe));
  log(`posts=${posts.length} dohe=${dohe.length} changed=${changed}`);
  return { posts: posts.length, dohe: dohe.length, changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e.message); process.exit(1); });
}
