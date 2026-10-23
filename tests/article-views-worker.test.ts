import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createArticleViewsWorker, type Database, type Statement, type Env } from '../workers/article-views/src/index';

const ID = 'f0edfa90-8d05-4d6b-bb06-1247f68ec7d0';
const EVENT = 'f8cc4b6d-1b1c-4fc4-8dbf-f3cf46942b3a';
const schema = readFileSync(new URL('../workers/article-views/migrations/0001_views.sql', import.meta.url), 'utf8');
function database(file = ':memory:') {
  const sql = new DatabaseSync(file); sql.exec(schema);
  const adapter = {
    prepare(query: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first() { return sql.prepare(query).get(...values as never[]) ?? null; },
        async run() { return sql.prepare(query).run(...values as never[]); },
        exec() { return sql.prepare(query).all(...values as never[]); }
      };
    },
    async batch(statements: Array<Statement & { exec(): unknown[] }>) {
      sql.exec('BEGIN');
      try { const result = statements.map((statement) => ({ results: statement.exec() })); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    }
  } as unknown as Database;
  return { sql, adapter };
}
const request = (method = 'GET', eventId = EVENT, origin = 'https://blog.pureastar.top', id = ID) => new Request('https://blog.pureastar.top/api/views/' + id, {
  method, headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify({ eventId }) } : {})
});
function fixture() {
  const db = database();
  const allow = { limit: vi.fn(async () => ({ success: true })) };
  const env: Env = { DB: db.adapter, READ_LIMIT: allow, WRITE_LIMIT: allow, VIEWS_ENABLED: 'true' };
  const manifest = vi.fn(async () => Response.json({ version: 1, articleIds: [ID] })) as unknown as typeof fetch;
  return { ...db, env, allow, manifest, worker: createArticleViewsWorker(manifest) };
}
describe('real SQLite counter and Worker request validation', () => {
  it('GET never writes; duplicate events never increment, new events do', async () => {
    const { worker, env, sql } = fixture();
    expect(await (await worker.fetch(request(), env)).json()).toEqual({ id: ID, views: 0 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_receipts').get()?.['n']).toBe(0);
    expect(await (await worker.fetch(request('POST'), env)).json()).toEqual({ id: ID, views: 1, counted: true });
    expect(await (await worker.fetch(request('POST'), env)).json()).toEqual({ id: ID, views: 1, counted: false });
    expect(await (await worker.fetch(request('POST', ID), env)).json()).toEqual({ id: ID, views: 2, counted: true });
    sql.close();
  });
  it('handles the budget boundary atomically while duplicate success remains valid', async () => {
    const { worker, env, sql } = fixture();
    sql.exec("INSERT INTO view_daily_budget VALUES(date('now'), 4999)");
    expect((await worker.fetch(request('POST'), env)).status).toBe(200);
    expect(sql.prepare('SELECT events FROM view_daily_budget').get()?.['events']).toBe(5000);
    const duplicate = await worker.fetch(request('POST'), env);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { counted: boolean }).counted).toBe(false);
    expect((await worker.fetch(request('POST', ID), env)).status).toBe(429);
    expect(sql.prepare('SELECT views FROM view_totals').get()?.['views']).toBe(1);
    sql.close();
  });
  it('rolls back the receipt and budget if the count trigger fails', async () => {
    const { worker, env, sql } = fixture();
    sql.exec(`INSERT INTO view_totals VALUES('${ID}', 9007199254740991)`);
    expect((await worker.fetch(request('POST'), env)).status).toBe(503);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_receipts').get()?.['n']).toBe(0);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_daily_budget').get()?.['n']).toBe(0);
    sql.close();
  });
  it('fails closed for previews, origin forgery, absent bindings, limits and unknown IDs', async () => {
    const { worker, env, sql, allow } = fixture();
    expect((await worker.fetch(new Request('https://write.pureastar.top/api/views/' + ID), env)).status).toBe(404);
    expect((await worker.fetch(request('POST', EVENT, 'https://evil.invalid'), env)).status).toBe(403);
    const disabled = { ...env }; delete disabled.VIEWS_ENABLED;
    const noDatabase = { ...env }; delete noDatabase.DB;
    expect((await worker.fetch(request(), disabled)).status).toBe(503);
    expect((await worker.fetch(request(), noDatabase)).status).toBe(503);
    expect((await worker.fetch(request('PUT'), env)).status).toBe(405);
    expect((await worker.fetch(request('GET', EVENT, 'https://blog.pureastar.top', EVENT), env)).status).toBe(404);
    allow.limit.mockResolvedValue({ success: false });
    expect((await worker.fetch(request('POST'), env)).status).toBe(429);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_receipts').get()?.['n']).toBe(0);
    sql.close();
  });
  it('rejects oversized/malformed input and manifest errors before writing', async () => {
    const { worker, env, sql } = fixture();
    const oversized = new Request(request('POST'), { body: JSON.stringify({ eventId: 'x'.repeat(600) }), headers: { Origin: 'https://blog.pureastar.top', 'CF-Connecting-IP': '192.0.2.1', 'content-type': 'application/json', 'content-length': '700' } });
    expect((await worker.fetch(oversized, env)).status).toBe(413);
    expect((await worker.fetch(request('POST', 'invalid'), env)).status).toBe(400);
    const failing = createArticleViewsWorker(vi.fn(async () => new Response('broken', { status: 500 })) as unknown as typeof fetch);
    expect((await failing.fetch(request('POST'), env)).status).toBe(503);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_receipts').get()?.['n']).toBe(0);
    sql.close();
  });
  it('uses the workerd-supported manual mode and refuses manifest redirects', async () => {
    const { env, sql } = fixture();
    const fetchManifest = vi.fn(async (_input: unknown, options?: RequestInit) => {
      expect(options?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } });
    });
    const worker = createArticleViewsWorker(fetchManifest as unknown as typeof fetch);
    expect((await worker.fetch(request('POST'), env)).status).toBe(503);
    expect(fetchManifest).toHaveBeenCalledOnce();
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_receipts').get()?.['n']).toBe(0);
    sql.close();
  });
  it('deletes expired receipts without deleting totals', async () => {
    const { worker, env, sql } = fixture();
    await worker.fetch(request('POST'), env);
    sql.exec('UPDATE view_receipts SET expires_at=0');
    await worker.scheduled(null, env);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM view_receipts').get()?.['n']).toBe(0);
    expect(sql.prepare('SELECT views FROM view_totals').get()?.['views']).toBe(1);
    sql.close();
  });
  it('handles independent concurrent SQLite connections for the same event exactly once', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'whono-view-sql-'));
    const file = path.join(directory, 'views.db');
    const { sql } = database(file); sql.exec('PRAGMA journal_mode=WAL');
    const code = `const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.file); db.exec('PRAGMA busy_timeout=5000'); db.prepare('INSERT OR IGNORE INTO view_receipts VALUES(?, ?, ?)').run(workerData.id,'one-event',9999999999); db.close(); parentPort.postMessage('ok');`;
    try {
      await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
        const thread = new Worker(code, { eval: true, workerData: { file, id: ID } });
        thread.once('message', () => resolve()); thread.once('error', reject);
        thread.once('exit', (status) => { if (status !== 0) reject(new Error('Concurrent writer failed')); });
      })));
      expect(sql.prepare('SELECT views FROM view_totals').get()?.['views']).toBe(1);
      expect(sql.prepare('SELECT events FROM view_daily_budget').get()?.['events']).toBe(1);
    } finally { sql.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
