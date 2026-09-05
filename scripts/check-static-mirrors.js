#!/usr/bin/env node
/**
 * Fail if Temara_Dashboard/<file> and Temara_Dashboard/public/<file> diverge.
 * Local `scripts/dev-server.js` serves the dashboard root; public/ is a deploy mirror.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', 'Temara_Dashboard');
const PUBLIC = path.join(ROOT, 'public');

const SKIP_DIRS = new Set(['api', 'public', 'node_modules', '_archive', '.git']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json']);

function walk(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
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
    out.push(rel.split(path.sep).join('/'));
  }
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const rootFiles = [];
walk(ROOT, ROOT, rootFiles);

const mismatches = [];
const missingPublic = [];
let compared = 0;

for (const rel of rootFiles) {
  const pub = path.join(PUBLIC, rel);
  if (!fs.existsSync(pub)) {
    if (/\.(js|html|css)$/.test(rel)) missingPublic.push(rel);
    continue;
  }
  compared += 1;
  const a = hashFile(path.join(ROOT, rel));
  const b = hashFile(pub);
  if (a !== b) mismatches.push(rel);
}

if (mismatches.length || missingPublic.length) {
  if (mismatches.length) {
    console.error('Static mirror mismatch (Temara_Dashboard/ vs public/):');
    mismatches.forEach((rel) => console.error(`  ${rel}`));
  }
  if (missingPublic.length) {
    console.error('Missing public/ copies:');
    missingPublic.forEach((rel) => console.error(`  ${rel}`));
  }
  console.error(`Compared ${compared} mirrored files.`);
  process.exit(1);
}

console.log(`Static mirrors OK (${compared} files).`);
