import fs from 'fs';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, '../out/chat/chatViewProvider.js');
const src = fs.readFileSync(outFile, 'utf8');

const marker = 'return `<!DOCTYPE html>';
const start = src.indexOf(marker);
if (start < 0) {
  console.error('HTML template not found');
  process.exit(1);
}
const tplStart = start + 'return '.length; // points at opening `
let i = tplStart + 1;
while (i < src.length) {
  if (src[i] === '\\') {
    i += 2;
    continue;
  }
  if (src[i] === '`') {
    break;
  }
  i += 1;
}
const templateLiteral = src.slice(tplStart, i + 1);
const html = Function(
  `"use strict"; const nonce = "test"; const csp = "default-src 'none'"; return ${templateLiteral};`,
)();
const m = html.match(/<script nonce="test">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('script not found in evaluated HTML');
  process.exit(1);
}
const jsPath = path.join(__dirname, '../out/_webview_check.js');
fs.writeFileSync(jsPath, m[1]);
const r = spawnSync(process.execPath, ['--check', jsPath], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
console.log('webview JS OK', m[1].length, 'chars');
