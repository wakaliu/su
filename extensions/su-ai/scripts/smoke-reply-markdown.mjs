import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { renderReplyMarkdown, SU_REPLY_FORMAT_HINT } = require(path.join(root, 'out/chat/replyMarkdown.js'));

const cases = [
  ['h', '# A\n## B\n### C\n#### D', (h) => h.includes('<h3>D') && h.includes('<h1>A')],
  ['tbl-basic', '| A | B |\n|---|---|\n| 1 | 2 |', (h) => h.includes('<table>') && h.includes('<th')],
  ['tbl-align', '|左|右|\n|:--|---:|\n|a|b|', (h) => h.includes('<table>') && h.includes('align-right')],
  ['list', '1. 一\n2. 二\n\n- x\n- y', (h) => h.includes('<ol') && h.includes('<ul>')],
  ['inline', '见 `x` 与 **粗**', (h) => h.includes('<code>x</code>') && h.includes('<strong>')],
  ['img', '看 ![示意](https://example.com/a.png)', (h) => h.includes('md-img zoomable') && h.includes('example.com/a.png')],
  ['fence', '```ts\nconst n=1;\n```', (h) => h.includes('reply-code') && h.includes('const n=1;')],
  ['misc', '> q\n\n---\n\nok', (h) => h.includes('<blockquote>') && h.includes('<hr>')],
];

let failed = 0;
for (const [name, src, ok] of cases) {
  const html = renderReplyMarkdown(src);
  const pass = ok(html);
  console.log((pass ? 'OK ' : 'FAIL ') + name);
  if (!pass) {
    failed += 1;
    console.log(html);
  }
}

// chatViewProvider embeds: new Function('return (' + ${mdRendererJson} + ')')()
const mdRendererJson = JSON.stringify(renderReplyMarkdown.toString());
const embedded = eval("new Function('return (' + " + mdRendererJson + " + ')')()");
const injectHtml = embedded('| A | B |\n|---|---|\n| 1 | 2 |');
if (typeof embedded !== 'function' || !injectHtml.includes('<table>')) {
  console.log('FAIL inject', typeof embedded, String(injectHtml).slice(0, 160));
  failed += 1;
} else {
  console.log('OK inject');
}

if (!SU_REPLY_FORMAT_HINT.includes('tables') || !SU_REPLY_FORMAT_HINT.includes('emoji')) {
  console.log('FAIL hint');
  failed += 1;
} else {
  console.log('OK hint');
}

if (failed) {
  process.exit(1);
}
console.log('smoke-reply-markdown OK');
