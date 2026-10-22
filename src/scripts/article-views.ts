import {
  isViewId, isCountableArticlePage, parseViewCount, VIEW_WINDOW_MS, VIEW_VISIBLE_MS
} from '../lib/article-views-contract';

export type ViewEvent = { eventId: string; createdAt: number; completed: boolean };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export function getViewEvent(storage: StorageLike | null, id: string, now: number, uuid: () => string): ViewEvent {
  try {
    const stored: unknown = JSON.parse(storage?.getItem('article-view:' + id) ?? 'null');
    if (stored && typeof stored === 'object') {
      const old = stored as ViewEvent;
      if (isViewId(old.eventId) && typeof old.createdAt === 'number' && typeof old.completed === 'boolean'
          && now >= old.createdAt && now - old.createdAt < VIEW_WINDOW_MS) return old;
    }
  } catch { /* Storage is optional; counting never blocks the article. */ }
  const event = { eventId: uuid(), createdAt: now, completed: false };
  saveViewEvent(storage, id, event);
  return event;
}
export function saveViewEvent(storage: StorageLike | null, id: string, event: ViewEvent): void {
  try { storage?.setItem('article-view:' + id, JSON.stringify(event)); } catch { /* Optional. */ }
}

/** Accumulate only foreground time. Inject a monotonic clock and timer for tests. */
export function visibleDelay(
  duration: number, done: () => void,
  clock: () => number = () => performance.now(),
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout
) {
  let remaining = duration;
  let started = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  return {
    setVisible(visible: boolean) {
      if (finished) return;
      if (handle !== null) { cancel(handle); handle = null; remaining -= Math.max(0, clock() - started); }
      if (!visible) return;
      started = clock();
      handle = schedule(() => { handle = null; finished = true; done(); }, Math.max(0, remaining));
    },
    dispose() { finished = true; if (handle !== null) cancel(handle); handle = null; }
  };
}

export async function requestViewCount(
  id: string, eventId?: string, fetcher: typeof fetch = fetch
): Promise<number> {
  const response = await fetcher('/api/views/' + id, {
    method: eventId ? 'POST' : 'GET',
    cache: 'no-store', credentials: 'same-origin',
    signal: AbortSignal.timeout(5000),
    headers: eventId ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    ...(eventId ? { body: JSON.stringify({ eventId }) } : {})
  });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('View count unavailable');
  }
  const payload: unknown = await response.json();
  if (eventId && (!payload || typeof payload !== 'object'
      || typeof (payload as Record<string, unknown>)['counted'] !== 'boolean')) {
    throw new Error('Invalid write acknowledgement');
  }
  const count = parseViewCount(payload, id);
  if (count === null) throw new Error('Invalid view count response');
  return count;
}

function initArticleViews(element: HTMLElement): void {
  element.hidden = true;
  const id = element.dataset['articleViews'];
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';
  if (!isCountableArticlePage(import.meta.env.PROD, window.location.href, canonical, id) || !isViewId(id)) return;
  const label = element.querySelector<HTMLElement>('[data-article-views-number]');
  if (!label) return;
  let storage: StorageLike | null = null;
  try { storage = window.localStorage; } catch { /* Restricted browser storage. */ }
  let disposed = false;
  const show = (count: number) => {
    if (disposed) return;
    label.textContent = new Intl.NumberFormat('zh-CN').format(count);
    element.hidden = false;
  };
  const hide = () => { if (!disposed) element.hidden = true; };
  // Keep the initial read separate from the write; GET must never count a visit.
  const initialRead = requestViewCount(id).then(show).catch(hide);
  const delay = visibleDelay(VIEW_VISIBLE_MS, () => {
    void (async () => {
      await initialRead;
      if (disposed) return;
      const event = getViewEvent(storage, id, Date.now(), () => crypto.randomUUID());
      if (event.completed) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const count = await requestViewCount(id, event.eventId);
          if (disposed) return;
          event.completed = true;
          saveViewEvent(storage, id, event);
          show(count);
          return;
        } catch { if (attempt === 1) hide(); }
      }
    })();
  });
  const visibility = () => delay.setVisible(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    disposed = true; delay.dispose(); document.removeEventListener('visibilitychange', visibility);
    // A BFCache restoration does not execute this module again. Start a new
    // page lifecycle, retaining the same persisted 30-minute event identity.
    if (event.persisted) {
      window.addEventListener('pageshow', () => initArticleViews(element), { once: true });
    }
  }, { once: true });
  visibility();
}
if (typeof document !== 'undefined') {
  document.querySelectorAll<HTMLElement>('[data-article-views]').forEach(initArticleViews);
}
