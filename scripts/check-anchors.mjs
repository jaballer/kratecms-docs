#!/usr/bin/env node
/**
 * Validate every in-repo link fragment against the real heading ids.
 *
 * `mint broken-links` checks page paths but not fragments, so a link to a
 * heading that does not exist passes it silently and drops the reader at the
 * top of the page. This closes that gap.
 *
 * It reads ids out of a `mint export` build rather than deriving them from the
 * headings itself. That is the whole point: Mintlify keeps `/` when it builds
 * an id, so `## POST /api/v1/posts/{id}/audio` becomes
 * `post-/api/v1/posts/id/audio`, and a hand-rolled slugify gets it wrong in
 * exactly the cases that matter.
 *
 * Usage: node scripts/check-anchors.mjs <export-dir>
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const exportDir = process.argv[2];

if (!exportDir || !existsSync(exportDir)) {
  console.error('usage: node scripts/check-anchors.mjs <export-dir>');
  console.error('  <export-dir> is an unzipped `mint export` build.');
  process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'drafts', 'scripts']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.mdx')) out.push(full);
  }
  return out;
}

/** Strip fenced and inline code so links in examples are not treated as real. */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const headingCache = new Map();

/** Heading ids for a site path such as "/api/posts", read from the export. */
function headingIds(pagePath) {
  if (headingCache.has(pagePath)) return headingCache.get(pagePath);

  const rel = pagePath === '/' ? 'index.html' : join(pagePath.replace(/^\//, ''), 'index.html');
  const file = join(exportDir, rel);

  let ids = null; // null distinguishes "no such page" from "page with no headings"
  if (existsSync(file)) {
    const html = readFileSync(file, 'utf8');
    ids = new Set();
    for (const m of html.matchAll(/<h[1-6][^>]*\bid="([^"]+)"/g)) ids.add(m[1]);
  }

  headingCache.set(pagePath, ids);
  return ids;
}

const root = process.cwd();
const failures = [];
let checked = 0;

for (const file of walk(root)) {
  const source = stripCode(readFileSync(file, 'utf8'));
  // Own site path, e.g. content/media.mdx -> /content/media
  const ownPath = '/' + relative(root, file).replace(/\.mdx$/, '');

  for (const m of source.matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
    const [, target, rawFragment] = m;

    // External links are someone else's problem.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

    const pagePath = target === '' ? ownPath : target.replace(/\/$/, '');
    if (!pagePath.startsWith('/')) continue; // relative paths are not used here

    checked++;
    const ids = headingIds(pagePath);

    if (ids === null) {
      failures.push({ file: relative(root, file), link: `${target}#${rawFragment}`, why: `no exported page at ${pagePath}` });
      continue;
    }

    // Compare raw and percent-decoded; Mintlify's own TOC emits the encoded form.
    let decoded = rawFragment;
    try { decoded = decodeURIComponent(rawFragment); } catch { /* keep raw */ }

    if (!ids.has(rawFragment) && !ids.has(decoded)) {
      failures.push({
        file: relative(root, file),
        link: `${target}#${rawFragment}`,
        why: `no heading with that id on ${pagePath}`,
      });
    }
  }
}

if (failures.length === 0) {
  console.log(`✓ ${checked} link fragments all resolve to real headings`);
  process.exit(0);
}

console.error(`✗ ${failures.length} of ${checked} link fragments do not resolve:\n`);
for (const f of failures) {
  console.error(`  ${f.file}`);
  console.error(`    ${f.link}`);
  console.error(`    ${f.why}\n`);
}
console.error('Heading ids come from the built site. Mintlify keeps "/" in an id —');
console.error('"## POST /api/v1/posts/{id}/audio" becomes "post-/api/v1/posts/id/audio".');
process.exit(1);
