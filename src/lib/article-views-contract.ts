/** Public identifiers, never credentials. Counters are visits, not unique people. */
export const ARTICLE_VIEWS_ORIGIN = 'https://blog.pureastar.top';
export const ARTICLE_VIEWS_MANIFEST_URL = 'https://astro-whono-9fl.pages.dev/article-views-manifest.json';
export const VIEW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const VIEW_WINDOW_MS = 30 * 60 * 1000;
export const VIEW_VISIBLE_MS = 5000;

export const isViewId = (value: unknown): value is string =>
  typeof value === 'string' && VIEW_ID_RE.test(value);

export function getPublicViewIds(entries: ReadonlyArray<{ data: { draft?: boolean | undefined; viewId?: string | undefined } }>): string[] {
  const ids = new Set<string>();
  for (const { data } of entries) {
    if (data.draft || !data.viewId) continue;
    if (!isViewId(data.viewId)) throw new Error('Invalid article viewId');
    if (ids.has(data.viewId)) throw new Error('Duplicate article viewId: ' + data.viewId);
    ids.add(data.viewId);
  }
  return [...ids].sort();
}

export function isCountableArticlePage(production: boolean, current: string, canonical: string, id: unknown): boolean {
  if (!production || !isViewId(id)) return false;
  try {
    const page = new URL(current);
    const target = new URL(canonical);
    return page.origin === ARTICLE_VIEWS_ORIGIN && target.origin === ARTICLE_VIEWS_ORIGIN
      && /^\/archive\/[^/]+\/$/.test(target.pathname) && page.pathname === target.pathname;
  } catch { return false; }
}

export function parseViewCount(value: unknown, id: string): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return record['id'] === id && Number.isSafeInteger(record['views']) && (record['views'] as number) >= 0
    ? record['views'] as number : null;
}
