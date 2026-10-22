import { describe, it, expect, vi, afterEach } from 'vitest';
import { isCountableArticlePage, getPublicViewIds, parseViewCount, VIEW_WINDOW_MS } from '../src/lib/article-views-contract';
import { getViewEvent, saveViewEvent, visibleDelay, requestViewCount } from '../src/scripts/article-views';

const ID = 'f0edfa90-8d05-4d6b-bb06-1247f68ec7d0';
const EVENT = 'f8cc4b6d-1b1c-4fc4-8dbf-f3cf46942b3a';
afterEach(() => vi.useRealTimers());
describe('article reading counter boundary', () => {
  it('counts only production canonical details on the formal origin', () => {
    const url = 'https://blog.pureastar.top/archive/example/';
    expect(isCountableArticlePage(true, url, url, ID)).toBe(true);
    for (const current of ['https://write.pureastar.top/archive/example/', 'http://localhost:4321/archive/example/', 'https://astro-whono-9fl.pages.dev/archive/example/', 'https://blog.pureastar.top/essay/example/', 'https://blog.pureastar.top/archive/']) {
      expect(isCountableArticlePage(true, current, url, ID)).toBe(false);
    }
    expect(isCountableArticlePage(false, url, url, ID)).toBe(false);
  });
  it('excludes drafts and missing IDs, rejects duplicates rather than sharing counts', () => {
    const draft = { data: { draft: true, viewId: EVENT } };
    expect(getPublicViewIds([{ data: { viewId: ID } }, draft, { data: {} }])).toEqual([ID]);
    expect(() => getPublicViewIds([{ data: { viewId: ID } }, { data: { viewId: ID } }])).toThrow('Duplicate');
  });
  it('reuses events across refreshes for30min and handles blocked/corrupt storage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    const event = getViewEvent(storage, ID, 100, () => EVENT);
    event.completed = true; saveViewEvent(storage, ID, event);
    expect(getViewEvent(storage, ID, 200, () => ID)).toEqual(event);
    expect(getViewEvent(storage, ID, 100 + VIEW_WINDOW_MS, () => ID).eventId).toBe(ID);
    const denied = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(getViewEvent(denied, ID, 200, () => EVENT).eventId).toBe(EVENT);
  });
  it('pauses its5second clock when the page is hidden', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const delay = visibleDelay(5000, callback, () => Date.now());
    delay.setVisible(true); vi.advanceTimersByTime(2000);
    delay.setVisible(false); vi.advanceTimersByTime(60000);
    expect(callback).not.toHaveBeenCalled();
    delay.setVisible(true); vi.advanceTimersByTime(2999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledOnce();
    delay.setVisible(true); vi.advanceTimersByTime(5000); expect(callback).toHaveBeenCalledOnce();
  });
  it('rejects the Pages HTML fallback, errors and invalid numbers, allowing a true zero', async () => {
    expect(parseViewCount({ id: ID, views: 0 }, ID)).toBe(0);
    expect(parseViewCount({ id: EVENT, views: 5 }, ID)).toBeNull();
    expect(parseViewCount({ id: ID, views: -1 }, ID)).toBeNull();
    const html = vi.fn(async () => new Response('<html>404</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(requestViewCount(ID, undefined, html)).rejects.toThrow();
    const failed = vi.fn(async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(requestViewCount(ID, undefined, failed)).rejects.toThrow();
    const missingAck = vi.fn(async () => Response.json({ id: ID, views: 0 })) as unknown as typeof fetch;
    await expect(requestViewCount(ID, EVENT, missingAck)).rejects.toThrow('acknowledgement');
    const good = vi.fn(async () => Response.json({ id: ID, views: 0, counted: false })) as unknown as typeof fetch;
    expect(await requestViewCount(ID, EVENT, good)).toBe(0);
    expect(JSON.parse((good as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)).toEqual({ eventId: EVENT });
  });
});
