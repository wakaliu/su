/**
 * Markdown subset for Su chat replies (headings, lists, GFM tables, fences).
 * Must stay dependency-free so `Function`/`toString` can inject it into the Webview.
 */
export const SU_REPLY_FORMAT_HINT =
  'Format substantial answers like a polished IDE coding assistant (Cursor-style): ' +
  'lead with a short conclusion; use ## / ### section titles that stand out; keep paragraphs short; ' +
  'use bullets or numbered lists for steps; use Markdown pipe tables for comparisons, inventories, and structured facts; ' +
  'put real code in fenced blocks with a language tag — never wrap the whole answer in one fence. Prefer structure over walls of text.';

export function renderReplyMarkdown(source: string): string {
  const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);

  function inline(text: string, depth = 0): string {
    if (depth >= 8) return escape(text);
    // Match tokens on the original text, never on already generated HTML.
    const token = /\\([\\`*_|\[\]])|(`+)([^\n]*?)\2(?!`)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(\*\*|__)(?=\S)(.+?\S|\S)\6|\*(?=\S)([^*\n]+?)\*/g;
    let html = '';
    let end = 0;
    for (const match of text.matchAll(token)) {
      const index = match.index!;
      html += escape(text.slice(end, index));
      const [, literal, ticks, code, label, href, , bold, emphasis] = match;
      if (literal) html += escape(literal);
      else if (ticks) html += '<code>' + escape(code) + '</code>';
      else if (href) html += '<a href="' + escape(href) + '">' + escape(label) + '</a>';
      else if (bold) html += '<strong>' + inline(bold, depth + 1) + '</strong>';
      else if (emphasis) html += '<em>' + inline(emphasis, depth + 1) + '</em>';
      end = index + match[0].length;
    }
    return html + escape(text.slice(end));
  }

  function cells(line: string): string[] {
    const parts = [''];
    // An escaped pipe or a pipe inside inline code belongs to the cell.
    for (const match of line.trim().matchAll(/\\.|(`+)[^\n]*?\1(?!`)|\||[^\\`|]+|[\\`]/g)) {
      if (match[0] === '|') parts.push('');
      else parts[parts.length - 1] += match[0];
    }
    if (parts.length > 1 && parts[0] === '') parts.shift();
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return parts.map((part) => part.trim());
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w.+#-]*)[^\n]*$/;
  const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
  const rule = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const quote = /^ {0,3}>[ \t]?(.*)$/;
  const list = /^ {0,3}([-+*]|\d{1,9}[.)])[ \t]+(.+)$/;
  const blocks: string[] = [];
  let i = 0;

  function tableAt(index: number): { labels: string[]; align: string[] } | undefined {
    const head = lines[index];
    const separator = lines[index + 1];
    if (!head?.includes('|') || !separator || !separator.includes('|')) return;
    const labels = cells(head);
    const markers = cells(separator);
    // GFM wants 3+ dashes; LLMs often emit :-- / --- with 2+. Accept 2+ so tables still render.
    if (labels.length !== markers.length || !markers.every((marker) => /^:?-{2,}:?$/.test(marker))) return;
    return { labels, align: markers.map((marker) => marker.endsWith(':')
      ? (marker.startsWith(':') ? ' class="align-center"' : ' class="align-right"') : '') };
  }

  const startsBlock = (line: string): boolean =>
    fence.test(line) || heading.test(line) || rule.test(line) || quote.test(line) || list.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const open = line.match(fence);
    const title = line.match(heading);
    const item = line.match(list);
    if (open) {
      const close = new RegExp('^ {0,3}' + open[1][0] + '{' + open[1].length + ',}[ \\t]*$');
      const code: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push('<div class="reply-code"><div class="code-actions"><span>' + escape(open[2] || '代码') +
        '</span><button type="button" data-copy>复制</button><button type="button" data-apply>应用</button></div>' +
        '<pre><code>' + escape(code.join('\n')) + '</code></pre></div>');
    } else if (title) {
      // Chat density: collapse ####+ into h3 so titles stay prominent without deep nesting.
      const tag = 'h' + Math.min(title[1].length, 3);
      blocks.push('<' + tag + '>' + inline(title[2].replace(/\s+#+$/, '')) + '</' + tag + '>');
      i++;
    } else if (rule.test(line)) {
      blocks.push('<hr>');
      i++;
    } else if (quote.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && quote.test(lines[i])) quoted.push(inline(lines[i++].match(quote)![1]));
      blocks.push('<blockquote>' + quoted.join('<br>') + '</blockquote>');
    } else if (item) {
      const ordered = /^\d/.test(item[1]);
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? ' start="' + parseInt(item[1], 10) + '"' : '';
      const entries: string[] = [];
      while (i < lines.length && !rule.test(lines[i])) {
        const next = lines[i].match(list);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        entries.push('<li>' + inline(next[2]) + '</li>');
        i++;
      }
      blocks.push('<' + tag + start + '>' + entries.join('') + '</' + tag + '>');
    } else {
      const table = tableAt(i);
      if (table) {
        const row = (tag: 'th' | 'td', values: string[]): string => '<tr>' + table.labels.map((_, col) =>
          '<' + tag + (tag === 'th' ? ' scope="col"' : '') + table.align[col] + '>' +
          inline(values[col] ?? '') + '</' + tag + '>').join('') + '</tr>';
        const rows: string[] = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && !startsBlock(lines[i]) && !tableAt(i)) {
          rows.push(row('td', cells(lines[i++])));
        }
        blocks.push('<div class="reply-table" role="region" aria-label="答复表格" tabindex="0"><table><thead>' +
          row('th', table.labels) + '</thead><tbody>' + rows.join('') + '</tbody></table></div>');
      } else {
        const paragraph = [inline(line)];
        i++;
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !tableAt(i)) {
          paragraph.push(inline(lines[i++]));
        }
        blocks.push('<p>' + paragraph.join('<br>') + '</p>');
      }
    }
  }
  return blocks.join('');
}
