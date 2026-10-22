// Local workerd/D1 integration. No account login or remote resource is used.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getPlatformProxy } from 'wrangler';

const root = new URL('../', import.meta.url);
const temporary = new URL('.runtime-test/', root);
await mkdir(temporary, { recursive: true });
const configPath = fileURLToPath(new URL('wrangler.json', temporary));
await writeFile(configPath, JSON.stringify({
  name: 'article-views-local-test', main: '../src/index.ts', compatibility_date: '2026-10-21',
  workers_dev: false, routes: [],
  d1_databases: [{ binding: 'DB', database_name: 'local-views', database_id: '00000000-0000-4000-8000-000000000001' }],
  ratelimits: [
    { name: 'READ_LIMIT', namespace_id: '901', simple: { limit: 60, period: 60 } },
    { name: 'WRITE_LIMIT', namespace_id: '902', simple: { limit: 20, period: 60 } }
  ]
}));
await build({ entryPoints: [fileURLToPath(new URL('src/index.ts', root))],
  outfile: fileURLToPath(new URL('worker.mjs', temporary)), bundle: true, format: 'esm', platform: 'browser' });
const { createArticleViewsWorker } = await import(new URL('worker.mjs', temporary));
const proxy = await getPlatformProxy({ configPath, persist: false });
try {
  const db = proxy.env.DB;
  const schema = await readFile(new URL('migrations/0001_views.sql', root), 'utf8');
  const statements = schema.match(/CREATE TABLE[\s\S]*?;|CREATE INDEX[^;]*;|CREATE TRIGGER[\s\S]*?END;/g);
  assert.equal(statements?.length, 6);
  await db.batch(statements.map((sql) => db.prepare(sql)));
  const id = 'f0edfa90-8d05-4d6b-bb06-1247f68ec7d0';
  const eventId = 'f8cc4b6d-1b1c-4fc4-8dbf-f3cf46942b3a';
  const allowed = { limit: async () => ({ success: true }) };
  const env = { DB: db, READ_LIMIT: allowed, WRITE_LIMIT: allowed, VIEWS_ENABLED: 'true' };
  const worker = createArticleViewsWorker(async () => Response.json({ version: 1, articleIds: [id] }));
  const request = (event) => new Request('https://blog.pureastar.top/api/views/' + id, {
    method: event ? 'POST' : 'GET',
    headers: { origin: 'https://blog.pureastar.top', 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    ...(event ? { body: JSON.stringify({ eventId: event }) } : {})
  });
  const count = async () => (await db.prepare('SELECT views FROM view_totals WHERE article_id=?').bind(id).first())?.views ?? 0;
  assert.equal((await (await worker.fetch(request(), env)).json()).views, 0);
  const duplicateResults = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await worker.fetch(request(eventId), env); assert.equal(response.status, 200); return response.json();
  }));
  assert.equal(duplicateResults.filter((result) => result.counted).length, 1);
  assert.equal(await count(), 1);
  await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await worker.fetch(request(crypto.randomUUID()), env); assert.equal(response.status, 200);
  }));
  assert.equal(await count(), 9);
  await db.prepare("UPDATE view_daily_budget SET events=4999 WHERE day=date('now')").run();
  const boundary = crypto.randomUUID();
  assert.equal((await worker.fetch(request(boundary), env)).status, 200);
  assert.equal((await worker.fetch(request(boundary), env)).status, 200);
  assert.equal((await worker.fetch(request(crypto.randomUUID()), env)).status, 429);
  assert.equal(await count(), 10);
  await db.prepare("UPDATE view_daily_budget SET events=0 WHERE day=date('now')").run();
  await db.prepare('UPDATE view_totals SET views=9007199254740991 WHERE article_id=?').bind(id).run();
  const beforeReceipts = (await db.prepare('SELECT COUNT(*) AS n FROM view_receipts').first()).n;
  assert.equal((await worker.fetch(request(crypto.randomUUID()), env)).status, 503);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM view_receipts').first()).n, beforeReceipts);
  assert.equal((await db.prepare('SELECT events FROM view_daily_budget').first()).events, 0);
  await db.prepare('UPDATE view_receipts SET expires_at=0').run();
  await worker.scheduled(null, env);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM view_receipts').first()).n, 0);
  assert.equal(await count(), 9007199254740991);
  // Validate the actual local rate-limit binding separately from counting fixtures.
  assert.equal((await proxy.env.READ_LIMIT.limit({ key: 'local-binding-test' })).success, true);
  console.log('PASS: local workerd/D1 migration, parallel idempotency, distinct events, budget, rollback, retention, rate binding');
} finally {
  await proxy.dispose();
  await rm(temporary, { recursive: true, force: true });
}
