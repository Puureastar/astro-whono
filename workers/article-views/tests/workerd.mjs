// Execute the actual default Worker export in workerd, including native fetch.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = new URL('../', import.meta.url);
const temporary = await mkdtemp(path.join(tmpdir(), 'article-views-workerd-'));
const id = 'f0edfa90-8d05-4d6b-bb06-1247f68ec7d0';
const eventId = 'f8cc4b6d-1b1c-4fc4-8dbf-f3cf46942b3a';
const schema = await readFile(new URL('migrations/0001_views.sql', root), 'utf8');
const statements = schema.match(/CREATE TABLE[\s\S]*?;|CREATE INDEX[^;]*;|CREATE TRIGGER[\s\S]*?END;/g);
assert.equal(statements?.length, 6);
try {
  const scriptPath = path.join(temporary, 'worker.mjs');
  // Like Wrangler's entrypoint facade, expose only the deployed handler.
  await build({ stdin: { contents: "export { default } from './src/index.ts';", resolveDir: fileURLToPath(root) },
    outfile: scriptPath, bundle: true, format: 'esm', platform: 'browser' });
  for (const redirect of [false, true]) {
    let outboundCalls = 0;
    const mf = new Miniflare(convertV4MiniflareOptions({
      name: 'article-views-native-test', modules: true, script: await readFile(scriptPath, 'utf8'), compatibilityDate: '2026-10-21',
      bindings: { VIEWS_ENABLED: 'true' }, d1Databases: { DB: 'local-native-views' },
      ratelimits: {
        READ_LIMIT: { namespace_id: '901', simple: { limit: 60, period: 60 } },
        WRITE_LIMIT: { namespace_id: '902', simple: { limit: 20, period: 60 } }
      },
      outboundService: async (request) => {
        outboundCalls++;
        assert.equal(request.url, 'https://astro-whono-9fl.pages.dev/article-views-manifest.json');
        return redirect
          ? new Response(null, { status: 302, headers: { location: 'https://invalid.example/manifest' } })
          : Response.json({ version: 1, articleIds: [id] });
      }
    }));
    try {
      const db = await mf.getD1Database('DB');
      await db.batch(statements.map(sql => db.prepare(sql)));
      const call = async (post = false) => mf.dispatchFetch('https://blog.pureastar.top/api/views/' + id, {
        method: post ? 'POST' : 'GET',
        headers: { origin: 'https://blog.pureastar.top', 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
        ...(post ? { body: JSON.stringify({ eventId }) } : {})
      });
      if (redirect) {
        assert.equal((await call(true)).status, 503);
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM view_receipts').first()).n, 0);
      } else {
        const initial = await call();
        assert.equal(initial.status, 200);
        assert.deepEqual(await initial.json(), { id, views: 0 });
        assert.deepEqual(await (await call(true)).json(), { id, views: 1, counted: true });
        assert.deepEqual(await (await call(true)).json(), { id, views: 1, counted: false });
      }
      assert.equal(outboundCalls, 1);
    } finally { await mf.dispose(); }
  }
  console.log('PASS: actual workerd default export, native manifest fetch, D1 counting/idempotency, redirect rejection without writes');
} finally { await rm(temporary, { recursive: true, force: true }); }
