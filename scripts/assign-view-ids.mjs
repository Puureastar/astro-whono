// Explicit, optional maintenance command. Builds never change article sources.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseMarkdownFrontmatterDocument, splitMarkdownFrontmatter, patchMarkdownFrontmatter } from '../src/lib/admin-console/frontmatter.ts';

const root = fileURLToPath(new URL('../src/content/essay/', import.meta.url));
const write = process.argv.includes('--write');
const ids = new Set();
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { await visit(file); continue; }
    if (!item.isFile() || !item.name.endsWith('.md')) continue;
    const before = await readFile(file, 'utf8');
    const section = splitMarkdownFrontmatter(before);
    const document = parseMarkdownFrontmatterDocument(section.frontmatterText);
    const data = document.toJSON();
    if (!data || data.draft === true) continue;
    if (data.viewId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.viewId) || ids.has(data.viewId)) throw new Error('Invalid or duplicate viewId: ' + path.relative(root, file));
      ids.add(data.viewId); continue;
    }
    const id = randomUUID(); ids.add(id);
    const after = patchMarkdownFrontmatter(before, [{ path: ['viewId'], value: id, action: 'set' }]);
    const bodyHash = (value) => createHash('sha256').update(splitMarkdownFrontmatter(value).bodyText).digest('hex');
    if (bodyHash(before) !== bodyHash(after)) throw new Error('Refuse to modify article body');
    if (write) {
      if (await readFile(file, 'utf8') !== before) throw new Error('Concurrent article edit');
      await writeFile(file, after, 'utf8');
    }
    console.log((write ? 'Assigned: ' : 'Would assign: ') + path.relative(root, file));
  }
}
await visit(root);
if (!write) console.log('Dry run only. Add --write to assign IDs to published articles; drafts are skipped.');
