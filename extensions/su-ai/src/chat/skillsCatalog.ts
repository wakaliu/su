import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SuSkillSummary {
  id: string;
  name: string;
  description: string;
  source: 'workspace' | 'user-skills' | 'user-skills-cursor';
  dirName: string;
}

export interface SuSkill extends SuSkillSummary {
  body: string;
  filePath: string;
}

const MAX_SKILL_BODY = 24_000;

/**
 * Lists installed Agent Skills from workspace + Cursor user skill directories.
 */
export async function listInstalledSkills(): Promise<SuSkillSummary[]> {
  const roots = collectSkillRoots();
  const out: SuSkillSummary[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const skillFile = path.join(root.dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        continue;
      }
      const parsed = parseSkillFile(skillFile, ent.name, root.source);
      if (!parsed) {
        continue;
      }
      const id = `${root.source}:${ent.name}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push({
        id,
        name: parsed.name,
        description: parsed.description,
        source: root.source,
        dirName: ent.name,
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return out;
}

/**
 * Loads full skill markdown body by id (`source:dirName`).
 */
export async function loadSkillById(id: string): Promise<SuSkill | undefined> {
  const sep = id.indexOf(':');
  if (sep <= 0) {
    return undefined;
  }
  const source = id.slice(0, sep) as SuSkillSummary['source'];
  const dirName = id.slice(sep + 1);
  const roots = collectSkillRoots().filter((r) => r.source === source);
  for (const root of roots) {
    const skillFile = path.join(root.dir, dirName, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      continue;
    }
    const parsed = parseSkillFile(skillFile, dirName, source);
    if (!parsed) {
      continue;
    }
    return {
      id,
      name: parsed.name,
      description: parsed.description,
      source,
      dirName,
      body: parsed.body.slice(0, MAX_SKILL_BODY),
      filePath: skillFile,
    };
  }
  return undefined;
}

function collectSkillRoots(): Array<{ dir: string; source: SuSkillSummary['source'] }> {
  const roots: Array<{ dir: string; source: SuSkillSummary['source'] }> = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    roots.push({
      dir: path.join(folder.uri.fsPath, '.cursor', 'skills'),
      source: 'workspace',
    });
    roots.push({
      dir: path.join(folder.uri.fsPath, '.su', 'skills'),
      source: 'workspace',
    });
  }
  const home = os.homedir();
  roots.push({ dir: path.join(home, '.cursor', 'skills'), source: 'user-skills' });
  roots.push({ dir: path.join(home, '.cursor', 'skills-cursor'), source: 'user-skills-cursor' });
  return roots;
}

function parseSkillFile(
  filePath: string,
  dirName: string,
  _source: SuSkillSummary['source'],
): { name: string; description: string; body: string } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let name = dirName;
  let description = '';
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end > 0) {
      const fm = raw.slice(3, end).trim();
      body = raw.slice(end + 4).replace(/^\s+/, '');
      for (const line of fm.split(/\r?\n/)) {
        const mName = line.match(/^name:\s*(.+)$/i);
        if (mName) {
          name = stripQuotes(mName[1].trim());
        }
        const mDesc = line.match(/^description:\s*(.+)$/i);
        if (mDesc) {
          description = stripQuotes(mDesc[1].trim());
        }
      }
    }
  }
  if (!description) {
    const first = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    description = (first || name).slice(0, 160);
  }
  return { name, description: description.slice(0, 200), body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
