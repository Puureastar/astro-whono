import type { APIRoute } from 'astro';
import { getVisibleEssays } from '../lib/content';
import { getPublicViewIds } from '../lib/article-views-contract';

export const GET: APIRoute = async () => {
  const entries = await getVisibleEssays({ includeDraft: false });
  return new Response(JSON.stringify({ version: 1, articleIds: getPublicViewIds(entries) }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
};
