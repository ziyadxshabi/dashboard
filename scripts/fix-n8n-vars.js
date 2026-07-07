const fs = require('fs');
const path = require('path');

const n8nDir = path.join(__dirname, '..', 'n8n');
const files = fs.readdirSync(n8nDir).filter((f) => f.endsWith('.json'));

function standardizeJsCode(code) {
  if (!code || typeof code !== 'string') return code;
  let next = code;

  // String($env['KEY'] ?? '') -> String($vars['KEY'] ?? $env['KEY'] ?? '')
  next = next.replace(
    /String\(\$env\['([^']+)'\]\s*\?\?\s*''\)/g,
    "String($vars['$1'] ?? $env['$1'] ?? '')"
  );

  // String($vars['KEY'] ?? '') -> add $env fallback when missing
  next = next.replace(
    /String\(\$vars\['([^']+)'\]\s*\?\?\s*''\)/g,
    (match, key) => {
      if (match.includes(`$env['${key}']`)) return match;
      return `String($vars['${key}'] ?? $env['${key}'] ?? '')`;
    }
  );

  return next;
}

function walkAndFix(obj) {
  let changes = 0;
  if (!obj || typeof obj !== 'object') return changes;

  if (Array.isArray(obj)) {
    for (const item of obj) changes += walkAndFix(item);
    return changes;
  }

  for (const [key, value] of Object.entries(obj)) {
    if ((key === 'jsCode' || key === 'code') && typeof value === 'string') {
      const fixed = standardizeJsCode(value);
      if (fixed !== value) {
        obj[key] = fixed;
        changes += 1;
      }
    } else if (typeof value === 'object') {
      changes += walkAndFix(value);
    }
  }
  return changes;
}

let totalChanges = 0;
for (const file of files) {
  const filePath = path.join(n8nDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('SKIP invalid JSON:', file, e.message);
    continue;
  }
  const changes = walkAndFix(data);
  if (changes > 0) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(file + ': updated ' + changes + ' code block(s)');
    totalChanges += changes;
  }
}
console.log('Total code blocks updated:', totalChanges);
