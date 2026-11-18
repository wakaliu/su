import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatContentPart } from '../openaiClient';
import { loadSkillById } from './skillsCatalog';

export type ChatAttachment =
  | { kind: 'image'; name: string; mime: string; dataBase64: string }
  | { kind: 'file'; path: string }
  /** OS/webview drop without filesystem path — content already read in the webview. */
  | { kind: 'fileInline'; name: string; text: string }
  | { kind: 'folder'; path: string }
  | { kind: 'skill'; id: string; name?: string };

export interface BuiltUserTurn {
  /** Text persisted in session history (no large base64). */
  historyText: string;
  /** Message content for the API (may be multimodal). */
  apiContent: string | ChatContentPart[];
  /** Extra system prompt fragments (skills). */
  systemExtras: string[];
  /** Labels for UI chips echo. */
  labels: string[];
}

const MAX_TEXT_FILE = 100_000;
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_FOLDER_FILES = 40;
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.css',
  '.html',
  '.htm',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.cs',
  '.lua',
  '.sql',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.swift',
  '.rb',
  '.php',
  '.vue',
  '.svelte',
  '.gradle',
  '.properties',
  '.gitignore',
  '.env',
  '.dockerfile',
]);

/**
 * Builds history text + API content from user prompt and attachments.
 */
export async function buildUserTurn(
  prompt: string,
  attachments: ChatAttachment[] | undefined,
): Promise<BuiltUserTurn> {
  const parts: ChatContentPart[] = [];
  const historyChunks: string[] = [];
  const systemExtras: string[] = [];
  const labels: string[] = [];
  let hasImage = false;

  const trimmed = prompt.trim();
  if (trimmed) {
    historyChunks.push(trimmed);
  }

  for (const att of attachments || []) {
    if (att.kind === 'image') {
      const bytes = Buffer.from(att.dataBase64, 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) {
        historyChunks.push(`[图片过大已跳过: ${att.name}]`);
        continue;
      }
      const mime = att.mime || guessMime(att.name);
      const url = `data:${mime};base64,${att.dataBase64}`;
      parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
      historyChunks.push(`[图片: ${att.name}]`);
      labels.push(`🖼 ${att.name}`);
      hasImage = true;
      continue;
    }

    if (att.kind === 'skill') {
      const skill = await loadSkillById(att.id);
      if (!skill) {
        historyChunks.push(`[未找到 Skill: ${att.id}]`);
        continue;
      }
      systemExtras.push(
        `Follow this Agent Skill "${skill.name}" (from ${skill.source}):\n\n${skill.body}`,
      );
      historyChunks.push(`[Skill: ${skill.name}]`);
      labels.push(`/ ${skill.name}`);
      continue;
    }

    if (att.kind === 'file') {
      const fsPath = await resolveFsPath(att.path);
      if (!fsPath) {
        historyChunks.push(`[无法解析文件: ${att.path}]`);
        continue;
      }
      const block = await readFileBlock(fsPath);
      historyChunks.push(block);
      labels.push(path.basename(fsPath));
      continue;
    }

    if (att.kind === 'fileInline') {
      const name = att.name || 'file';
      let text = att.text || '';
      if (text.length > MAX_TEXT_FILE) {
        text = text.slice(0, MAX_TEXT_FILE) + '\n…(truncated)';
      }
      const lang = path.extname(name).replace(/^\./, '');
      historyChunks.push(`Referenced file: ${name}\n\`\`\`${lang}\n${text}\n\`\`\``);
      labels.push(name);
      continue;
    }

    if (att.kind === 'folder') {
      const fsPath = await resolveFsPath(att.path);
      if (!fsPath) {
        historyChunks.push(`[无法解析文件夹: ${att.path}]`);
        continue;
      }
      const block = await readFolderBlock(fsPath);
      historyChunks.push(block);
      labels.push(`${path.basename(fsPath)}/`);
    }
  }

  const historyText = historyChunks.join('\n\n').trim() || '(附件)';
  const textForApi = historyText;

  if (hasImage) {
    parts.unshift({ type: 'text', text: textForApi });
    return { historyText, apiContent: parts, systemExtras, labels };
  }

  return { historyText, apiContent: textForApi, systemExtras, labels };
}

/**
 * Resolves dropped URI strings (file:// or vscode-file / plain paths) to fs paths.
 */
export async function resolveDroppedUris(
  uris: string[],
): Promise<Array<{ kind: 'file' | 'folder' | 'image'; path?: string; name?: string; mime?: string; dataBase64?: string }>> {
  const out: Array<{
    kind: 'file' | 'folder' | 'image';
    path?: string;
    name?: string;
    mime?: string;
    dataBase64?: string;
  }> = [];

  for (const raw of uris) {
    const fsPath = await resolveFsPath(raw);
    if (!fsPath || !fs.existsSync(fsPath)) {
      continue;
    }
    const st = fs.statSync(fsPath);
    if (st.isDirectory()) {
      out.push({ kind: 'folder', path: fsPath });
      continue;
    }
    const ext = path.extname(fsPath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      if (st.size > MAX_IMAGE_BYTES) {
        continue;
      }
      const buf = fs.readFileSync(fsPath);
      out.push({
        kind: 'image',
        path: fsPath,
        name: path.basename(fsPath),
        mime: guessMime(fsPath),
        dataBase64: buf.toString('base64'),
      });
      continue;
    }
    out.push({ kind: 'file', path: fsPath });
  }
  return out;
}

async function resolveFsPath(input: string): Promise<string | undefined> {
  let s = (input || '').trim().replace(/^"+|"+$/g, '');
  if (!s) {
    return undefined;
  }
  // Windows file:///C:/... or file:///C%3A/...
  try {
    if (
      s.startsWith('file:') ||
      s.startsWith('vscode-file:') ||
      s.startsWith('vscode-resource:') ||
      s.includes('://')
    ) {
      const uri = vscode.Uri.parse(s);
      if (uri.scheme === 'file' || uri.fsPath) {
        const p = uri.fsPath;
        if (p && fs.existsSync(p)) {
          return p;
        }
      }
    }
  } catch {
    // fall through
  }
  // Decode percent-encoding leftover in plain paths
  try {
    if (/%[0-9A-Fa-f]{2}/.test(s)) {
      s = decodeURIComponent(s);
    }
  } catch {
    // keep original
  }
  if (path.isAbsolute(s) && fs.existsSync(s)) {
    return s;
  }
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    const candidate = path.join(f.uri.fsPath, s);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function readFileBlock(fsPath: string): Promise<string> {
  const rel = vscode.workspace.asRelativePath(fsPath, false);
  const ext = path.extname(fsPath).toLowerCase();
  if (!TEXT_EXT.has(ext) && !isProbablyText(fsPath)) {
    return `Referenced file (binary skipped): ${rel}`;
  }
  let text: string;
  try {
    const buf = fs.readFileSync(fsPath);
    if (buf.length > MAX_TEXT_FILE) {
      text = buf.subarray(0, MAX_TEXT_FILE).toString('utf8') + '\n…(truncated)';
    } else {
      text = buf.toString('utf8');
    }
  } catch (e) {
    return `Failed to read ${rel}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const lang = ext.replace(/^\./, '');
  return `Referenced file: ${rel}\n\`\`\`${lang}\n${text}\n\`\`\``;
}

async function readFolderBlock(fsPath: string): Promise<string> {
  const rel = vscode.workspace.asRelativePath(fsPath, false);
  const lines: string[] = [`Referenced folder: ${rel}`];
  const files: string[] = [];
  walkLimited(fsPath, fsPath, files, MAX_FOLDER_FILES);
  for (const f of files) {
    const r = path.relative(fsPath, f).replace(/\\/g, '/');
    lines.push(`- ${r}`);
  }
  if (files.length >= MAX_FOLDER_FILES) {
    lines.push('…(folder listing truncated)');
  }
  // Include a few small text files as samples.
  let included = 0;
  for (const f of files) {
    if (included >= 5) {
      break;
    }
    const ext = path.extname(f).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      continue;
    }
    try {
      const st = fs.statSync(f);
      if (st.size > 20_000) {
        continue;
      }
      lines.push('');
      lines.push(await readFileBlock(f));
      included += 1;
    } catch {
      // skip
    }
  }
  return lines.join('\n');
}

function walkLimited(root: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= limit) {
      return;
    }
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'out' || ent.name === 'dist') {
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkLimited(root, full, out, limit);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
}

function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

function isProbablyText(fsPath: string): boolean {
  try {
    const buf = fs.readFileSync(fsPath).subarray(0, 800);
    if (buf.includes(0)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
