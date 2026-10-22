import { it, expect, vi } from 'vitest';
const visibleEssays = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/content', () => ({ getVisibleEssays: visibleEssays }));
import { GET } from '../src/pages/article-views-manifest.json';

it('explicitly excludes drafts even when invoked from the development environment', async () => {
  const published = 'f0edfa90-8d05-4d6b-bb06-1247f68ec7d0';
  visibleEssays.mockResolvedValue([
    { data: { draft: false, viewId: published } },
    { data: { draft: true, viewId: 'f8cc4b6d-1b1c-4fc4-8dbf-f3cf46942b3a' } }
  ]);
  const response = await GET({} as never);
  expect(visibleEssays).toHaveBeenCalledWith({ includeDraft: false });
  expect(await response.json()).toEqual({ version: 1, articleIds: [published] });
  expect(response.headers.get('cache-control')).toBe('no-store');
});
