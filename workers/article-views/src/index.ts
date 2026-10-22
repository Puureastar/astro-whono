import { ARTICLE_VIEWS_ORIGIN, ARTICLE_VIEWS_MANIFEST_URL, isViewId } from '../../../src/lib/article-views-contract';

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T = Record<string, unknown>>(statements: Statement[]): Promise<Array<{ results: T[] }>>;
}
export interface RateLimiter { limit(input: { key: string }): Promise<{ success: boolean }> }
export interface Env { DB?: Database; READ_LIMIT?: RateLimiter; WRITE_LIMIT?: RateLimiter; VIEWS_ENABLED?: string }

const headers = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'vary': 'Origin'
};
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers });
const fail = (status: number, error: string) => reply(status, { error });

export const INSERT_RECEIPT_SQL = `INSERT OR IGNORE INTO view_receipts(article_id, event_hash, expires_at)
  VALUES(?, ?, ?) RETURNING event_hash`;
export const RESULT_SQL = `SELECT
  COALESCE((SELECT views FROM view_totals WHERE article_id = ?), 0) AS views,
  EXISTS(SELECT 1 FROM view_receipts WHERE article_id = ? AND event_hash = ?) AS receipt`;

async function limitedText(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!stream) throw new Error('Empty body');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('Oversized body'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const digest = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function createArticleViewsWorker(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let manifest: { ids: Set<string>; until: number } | null = null;
  let loading: Promise<Set<string>> | null = null;
  async function publicIds(): Promise<Set<string>> {
    if (manifest && now() < manifest.until) return manifest.ids;
    if (loading) return loading;
    loading = (async () => {
      const response = await fetcher(ARTICLE_VIEWS_MANIFEST_URL, {
        redirect: 'error', signal: AbortSignal.timeout(3000), cache: 'no-store',
        headers: { accept: 'application/json', 'cache-control': 'no-cache' }
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Manifest unavailable');
      const data = JSON.parse(await limitedText(response.body, 131072)) as Record<string, unknown>;
      if (data['version'] !== 1 || !Array.isArray(data['articleIds']) || data['articleIds'].length > 2000
          || !data['articleIds'].every(isViewId)) throw new Error('Invalid manifest');
      const ids = new Set<string>(data['articleIds']);
      if (ids.size !== data['articleIds'].length) throw new Error('Duplicate manifest ID');
      manifest = { ids, until: now() + 30000 };
      return ids;
    })();
    try { return await loading; } finally { loading = null; }
  }
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const id = /^\/api\/views\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.origin !== ARTICLE_VIEWS_ORIGIN || url.search || !isViewId(id)) return fail(404, 'not-found');
      if (request.method !== 'GET' && request.method !== 'POST') return fail(405, 'method-not-allowed');
      if (env.VIEWS_ENABLED !== 'true' || !env.DB || !env.READ_LIMIT || !env.WRITE_LIMIT) return fail(503, 'disabled');
      const origin = request.headers.get('Origin');
      if (origin && origin !== ARTICLE_VIEWS_ORIGIN) return fail(403, 'origin');
      if (request.method === 'POST' && (origin !== ARTICLE_VIEWS_ORIGIN
          || (request.headers.has('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin'))) return fail(403, 'origin');
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip || ip.length > 64) return fail(403, 'client');
      try {
        const key = await digest(ip);
        if (!(await env.READ_LIMIT.limit({ key })).success) return fail(429, 'rate-limit');
        if (request.method === 'POST' && !(await env.WRITE_LIMIT.limit({ key })).success) return fail(429, 'rate-limit');
        if (!(await publicIds()).has(id)) return fail(404, 'not-found');
        if (request.method === 'GET') {
          const row = await env.DB.prepare('SELECT views FROM view_totals WHERE article_id = ?').bind(id).first<{ views: number }>();
          const views = row?.views ?? 0;
          return validCount(views) ? reply(200, { id, views }) : fail(503, 'unavailable');
        }
        if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail(415, 'content-type');
        const length = request.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > 512)) return fail(413, 'body-too-large');
        let body: Record<string, unknown>;
        try {
          const data: unknown = JSON.parse(await limitedText(request.body, 512));
          if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'body');
          body = data as Record<string, unknown>;
        } catch { return fail(400, 'body'); }
        if (Object.keys(body).length !== 1 || !isViewId(body['eventId'])) return fail(400, 'event-id');
        const hash = await digest(id + ':' + body['eventId']);
        const results = await env.DB.batch([
          env.DB.prepare(INSERT_RECEIPT_SQL).bind(id, hash, Math.floor(now() / 1000) + 48 * 3600),
          env.DB.prepare(RESULT_SQL).bind(id, id, hash)
        ]);
        const row = results[1]?.results[0] as { views?: unknown; receipt?: unknown } | undefined;
        if (!row || !validCount(row.views)) return fail(503, 'unavailable');
        const counted = (results[0]?.results.length ?? 0) > 0;
        if (!counted && row.receipt !== 1) return fail(429, 'daily-budget');
        return reply(200, { id, views: row.views, counted });
      } catch {
        // No IP, payload, credentials, SQL or arbitrary exception text in application logs.
        console.error('article-views: unavailable');
        return fail(503, 'unavailable');
      }
    },
    async scheduled(_controller: unknown, env: Env): Promise<void> {
      if (!env.DB) throw new Error('Missing counter database');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM view_receipts WHERE expires_at < ?').bind(Math.floor(now() / 1000)),
        env.DB.prepare("DELETE FROM view_daily_budget WHERE day < date('now', '-3 days')")
      ]);
    }
  };
}
export default createArticleViewsWorker();
