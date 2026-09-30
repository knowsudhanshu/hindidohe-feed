import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSecretProof, run, toDohe, redact, writeIfChanged, buildDocument } from '../scripts/fetch-dohe.mjs';

const SYS = 'SYSTEM_USER_SECRET_TOKEN_123';
const PAGE = 'PAGE_SECRET_TOKEN_456';

// Fake Graph API: /{page}?fields=access_token and a 2-page /feed.
function fakeGraph({ failFeed = false, emptyFeed = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.pathname.endsWith('/166579083500816') && u.searchParams.get('fields') === 'access_token') {
      return u.searchParams.get('access_token') === SYS ? json(200, { access_token: PAGE, id: '166579083500816' })
        : json(400, { error: { code: 190, message: 'Invalid OAuth access token.' } });
    }
    if (u.pathname.endsWith('/166579083500816/feed')) {
      if (u.searchParams.get('access_token') !== PAGE) return json(400, { error: { code: 190, message: 'bad token' } });
      if (failFeed) return json(403, { error: { code: 10, message: 'Permission denied' } });
      if (emptyFeed) return json(200, { data: [] });
      if (!u.searchParams.get('after')) {
        return json(200, {
          data: [
            { id: 'p1', created_time: '2026-09-01T00:00:00+0000', message: 'दोहा एक\nअर्थ: एक', is_published: true },
            { id: 'p2', created_time: '2026-09-02T00:00:00+0000', message: 'Happy Diwali!', is_published: true },
            { id: 'p3', created_time: '2026-09-03T00:00:00+0000', message: 'draft\nअर्थ: x', is_published: false },
          ],
          // Facebook embeds the token in `next`; the script must not rely on / leak it.
          paging: { next: `https://graph.facebook.com/v26.0/166579083500816/feed?limit=100&after=CUR2&access_token=${PAGE}` },
        });
      }
      return json(200, { data: [
        { id: 'p4', created_time: '2026-09-04T00:00:00+0000', message: 'दोहा चार\nअर्थ: चार' },
        { id: 'p5', created_time: '2026-08-01T00:00:00+0000', message: 'दोहा  एक\nअर्थ:  एक' }, // whitespace duplicate of p1
      ] });
    }
    return json(404, { error: { code: 803, message: 'unknown path ' + u.pathname } });
  };
  return { fetchImpl, calls };
}

const tmpOut = async () => join(await mkdtemp(join(tmpdir(), 'dohe-')), 'public', 'dohe.json');

test('appsecret_proof is HMAC-SHA256(token, secret) — RFC 4231-style known vector', () => {
  assert.equal(appSecretProof('The quick brown fox jumps over the lazy dog', 'key'),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
});

test('system user token → derived page token → all pages fetched and filtered', async () => {
  const { fetchImpl, calls } = fakeGraph();
  const OUTPUT = await tmpOut();
  const logs = [];
  const r = await run({ FB_SYSTEM_USER_TOKEN: SYS, OUTPUT }, fetchImpl, (m) => logs.push(m));
  assert.deepEqual(r, { posts: 5, dohe: 2, changed: true });
  const doc = JSON.parse(await readFile(OUTPUT, 'utf8'));
  assert.equal(doc.schema, 1);
  assert.deepEqual(doc.dohe.map((d) => d.id), ['p4', 'p1']); // newest first, unpublished + non-doha + duplicate dropped
  assert.ok(calls.every((u) => u.pathname.startsWith('/v26.0/')), 'uses Graph v26.0');
  assert.equal(calls.filter((u) => u.pathname.endsWith('/feed')).length, 2, 'followed pagination');
  const written = await readFile(OUTPUT, 'utf8');
  for (const secret of [SYS, PAGE]) {
    assert.ok(!written.includes(secret), 'no token in output file');
    assert.ok(!logs.join('\n').includes(secret), 'no token in logs');
  }
});

test('appsecret_proof is sent on every call when FB_APP_SECRET is set', async () => {
  const { fetchImpl, calls } = fakeGraph();
  await run({ FB_SYSTEM_USER_TOKEN: SYS, FB_APP_SECRET: 's3cr3t', OUTPUT: await tmpOut() }, fetchImpl, () => {});
  for (const u of calls) {
    assert.equal(u.searchParams.get('appsecret_proof'), appSecretProof(u.searchParams.get('access_token'), 's3cr3t'));
  }
});

test('Graph errors fail the run with a redacted message and keep existing data', async () => {
  const OUTPUT = await tmpOut();
  await run({ FB_SYSTEM_USER_TOKEN: SYS, OUTPUT }, fakeGraph().fetchImpl, () => {});
  const before = await readFile(OUTPUT, 'utf8');
  await assert.rejects(run({ FB_SYSTEM_USER_TOKEN: SYS, OUTPUT }, fakeGraph({ failFeed: true }).fetchImpl, () => {}),
    (e) => { assert.match(e.message, /code=10/); assert.ok(!e.message.includes(PAGE) && !e.message.includes(SYS)); return true; });
  await assert.rejects(run({ FB_SYSTEM_USER_TOKEN: 'wrong', OUTPUT }, fakeGraph().fetchImpl, () => {}), /code=190/);
  await assert.rejects(run({ FB_SYSTEM_USER_TOKEN: SYS, OUTPUT }, fakeGraph({ emptyFeed: true }).fetchImpl, () => {}), /0 dohe/);
  assert.equal(await readFile(OUTPUT, 'utf8'), before, 'good data never overwritten on failure');
});

test('no token configured → clear error', async () => {
  await assert.rejects(run({ OUTPUT: await tmpOut() }, fakeGraph().fetchImpl, () => {}), /No token/);
});

test('unchanged dohe → no rewrite (keeps git history quiet)', async () => {
  const OUTPUT = await tmpOut();
  const d = toDohe([{ id: '1', message: 'क\nअर्थ: ख' }]);
  assert.equal(await writeIfChanged(OUTPUT, buildDocument(d, new Date(0))), true);
  assert.equal(await writeIfChanged(OUTPUT, buildDocument(d, new Date())), false);
});

test('redact() hides tokens in URLs', () => {
  assert.equal(redact('https://x/y?access_token=abc&appsecret_proof=def&a=1'),
    'https://x/y?access_token=REDACTED&appsecret_proof=REDACTED&a=1');
});
