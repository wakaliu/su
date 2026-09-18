import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface SuProductVersion {
  version: string;
  githubRepo: string;
}

const DEFAULTS: SuProductVersion = {
  version: '0.1.0',
  githubRepo: 'wakaliu/su',
};

/**
 * Loads the stamped product version shipped beside the extension (from branding/version.json).
 */
export function loadProductVersion(extensionPath: string): SuProductVersion {
  const candidates = [
    path.join(extensionPath, 'version.json'),
    path.join(extensionPath, '..', '..', '..', 'branding', 'version.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SuProductVersion>;
      return {
        version: String(raw.version || DEFAULTS.version).replace(/^v/i, ''),
        githubRepo: String(raw.githubRepo || DEFAULTS.githubRepo),
      };
    } catch {
      // try next candidate
    }
  }
  return { ...DEFAULTS };
}

/**
 * Compares dotted versions (optionally prefixed with v). Returns >0 if a>b.
 */
export function compareSemver(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .filter(Boolean)
      .map((p) => {
        const n = Number(p);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

export interface UpdateSettings {
  checkOnStartup: boolean;
  repo: string;
  includePrerelease: boolean;
}

export function getUpdateSettings(fallbackRepo: string): UpdateSettings {
  const cfg = vscode.workspace.getConfiguration('su');
  return {
    checkOnStartup: cfg.get<boolean>('update.checkOnStartup', true),
    repo: cfg.get<string>('update.repo', fallbackRepo) || fallbackRepo,
    includePrerelease: cfg.get<boolean>('update.includePrerelease', false),
  };
}
