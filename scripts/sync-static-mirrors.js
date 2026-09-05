#!/usr/bin/env node
/**
 * Copy Temara_Dashboard static files into Temara_Dashboard/public/
 * so Vercel-flatten and local-root serving stay identical.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'Temara_Dashboard');
const PUBLIC = path.join(ROOT, 'public');
const SKIP_DIRS = new Set(['api', 'public', 'node_modules', '_archive', '.git']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json']);

function walk(dir, base, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, base, out);
      continue;
    }
    out.push(rel);
  }
}

const files = [];
walk(ROOT, ROOT, files);
let copied = 0;
for (const rel of files) {
  const src = path.join(ROOT, rel);
  const dest = path.join(PUBLIC, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied += 1;
}
console.log(`Synced ${copied} files → Temara_Dashboard/public/`);
