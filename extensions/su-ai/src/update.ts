import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { compareSemver, getUpdateSettings, loadProductVersion, type SuProductVersion } from './version';

const SKIP_KEY = 'su.update.skippedVersion';
const STATE_LAST_CHECK = 'su.update.lastCheckAt';

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  body: string;
  htmlUrl: string;
  downloadUrl: string;
  assetName: string;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  content_type?: string;
  size?: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

/**
 * Handles GitHub Releases based update checks, prompts, and installer download for Windows.
 */
export class UpdateService {
  private readonly product: SuProductVersion;
  private checking = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.product = loadProductVersion(context.extensionPath);
  }

  get currentVersion(): string {
    return this.product.version;
  }

  /**
   * Registers commands and optional startup check (delayed, non-blocking).
   */
  activate(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('su.checkForUpdates', () => this.checkForUpdates({ manual: true })),
    );

    const settings = getUpdateSettings(this.product.githubRepo);
    if (!settings.checkOnStartup) {
      return;
    }
    const delay = setTimeout(() => {
      void this.checkForUpdates({ manual: false });
    }, 8000);
    this.context.subscriptions.push({ dispose: () => clearTimeout(delay) });
  }

  /**
   * Checks GitHub Releases for a newer Windows package and prompts the user.
   */
  async checkForUpdates(options: { manual: boolean }): Promise<void> {
    if (this.checking) {
      if (options.manual) {
        void vscode.window.showInformationMessage('正在检查更新…');
      }
      return;
    }
    this.checking = true;
    try {
      const settings = getUpdateSettings(this.product.githubRepo);
      const release = await this.fetchLatestRelease(settings.repo, settings.includePrerelease);
      await this.context.globalState.update(STATE_LAST_CHECK, Date.now());

      if (!release) {
        if (options.manual) {
          void vscode.window.showWarningMessage(
            `未找到可用的 GitHub Release（仓库 ${settings.repo}）。请确认已发布带 Windows 安装包的 tag。`,
          );
        }
        return;
      }

      if (compareSemver(release.version, this.product.version) <= 0) {
        if (options.manual) {
          void vscode.window.showInformationMessage(`已是最新版本（${this.product.version}）。`);
        }
        return;
      }

      const skipped = this.context.globalState.get<string>(SKIP_KEY);
      if (!options.manual && skipped && skipped === release.version) {
        return;
      }

      await this.promptUpdate(release, options.manual);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (options.manual) {
        void vscode.window.showErrorMessage(`检查更新失败：${msg}`);
      } else {
        console.warn('[su-ai] update check failed:', msg);
      }
    } finally {
      this.checking = false;
    }
  }

  private async promptUpdate(release: ReleaseInfo, manual: boolean): Promise<void> {
    const summary = release.body?.trim()
      ? release.body.trim().slice(0, 280)
      : release.name || release.tag;
    const hasInstaller = release.assetName !== 'release.html';
    const actions = hasInstaller
      ? (['下载并安装', '打开发布页', '稍后', '跳过此版本'] as const)
      : (['打开发布页', '稍后', '跳过此版本'] as const);
    const pick = await vscode.window.showInformationMessage(
      `发现新版本 ${release.version}（当前 ${this.product.version}）\n${summary}`,
      { modal: manual },
      ...actions,
    );

    if (pick === '下载并安装') {
      await this.downloadAndOpen(release);
    } else if (pick === '打开发布页') {
      await vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
    } else if (pick === '跳过此版本') {
      await this.context.globalState.update(SKIP_KEY, release.version);
    }
  }

  private async downloadAndOpen(release: ReleaseInfo): Promise<void> {
    const dest = path.join(os.tmpdir(), `su-update-${release.version}-${release.assetName}`);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在下载 su ${release.version}`,
        cancellable: true,
      },
      async (progress, token) => {
        await downloadFile(release.downloadUrl, dest, (ratio) => {
          progress.report({ increment: 0, message: `${Math.round(ratio * 100)}%` });
        }, token);
      },
    );

    if (!fs.existsSync(dest)) {
      void vscode.window.showErrorMessage('下载失败或已取消。');
      return;
    }

    const open = await vscode.window.showInformationMessage(
      `已下载到：${dest}\n请关闭 su 后运行安装包完成更新。`,
      '打开安装包',
      '打开所在文件夹',
    );
    if (open === '打开安装包') {
      await vscode.env.openExternal(vscode.Uri.file(dest));
    } else if (open === '打开所在文件夹') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dest));
    }
  }

  private async fetchLatestRelease(repo: string, includePrerelease: boolean): Promise<ReleaseInfo | undefined> {
    const api = includePrerelease
      ? `https://api.github.com/repos/${repo}/releases`
      : `https://api.github.com/repos/${repo}/releases/latest`;

    const raw = await httpsGetJson(api);
    const release = includePrerelease
      ? (raw as GitHubRelease[]).find((r) => !r.draft)
      : (raw as GitHubRelease);

    if (!release || release.draft) {
      return undefined;
    }
    if (!includePrerelease && release.prerelease) {
      return undefined;
    }

    const asset = pickWindowsAsset(release.assets || []);
    if (!asset) {
      // Still allow opening the release page even without a matched asset.
      return {
        tag: release.tag_name,
        version: release.tag_name.replace(/^v/i, ''),
        name: release.name || release.tag_name,
        body: release.body || '',
        htmlUrl: release.html_url,
        downloadUrl: release.html_url,
        assetName: 'release.html',
      };
    }

    return {
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/i, ''),
      name: release.name || release.tag_name,
      body: release.body || '',
      htmlUrl: release.html_url,
      downloadUrl: asset.browser_download_url,
      assetName: asset.name,
    };
  }
}

function pickWindowsAsset(assets: GitHubReleaseAsset[]): GitHubReleaseAsset | undefined {
  const ranked = assets
    .map((a) => ({ a, score: scoreAsset(a.name) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  return ranked[0]?.a;
}

function scoreAsset(name: string): number {
  const n = name.toLowerCase();
  if (!/(\.exe|\.msi|\.zip)$/.test(n)) {
    return 0;
  }
  let score = 1;
  if (n.includes('win32') || n.includes('windows') || n.includes('win-')) {
    score += 3;
  }
  if (n.includes('x64') || n.includes('amd64')) {
    score += 2;
  }
  if (n.endsWith('.exe') || n.endsWith('.msi')) {
    score += 2;
  }
  if (n.includes('setup') || n.includes('installer') || n.includes('user')) {
    score += 1;
  }
  if (n.includes('arm') || n.includes('darwin') || n.includes('linux')) {
    score -= 5;
  }
  return score;
}

function httpsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'su-editor-update-check',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetJson(res.headers.location).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`GitHub API HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('GitHub API timeout'));
    });
  });
}

function downloadFile(
  url: string,
  dest: string,
  onProgress: (ratio: number) => void,
  token: vscode.CancellationToken,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (current: string, redirects: number): void => {
      if (token.isCancellationRequested) {
        reject(new Error('cancelled'));
        return;
      }
      const req = https.get(current, { headers: { 'User-Agent': 'su-editor-update-check' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          follow(res.headers.location, redirects - 1);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`download HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            onProgress(Math.min(1, received / total));
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close();
          resolve();
        });
        out.on('error', reject);
        token.onCancellationRequested(() => {
          req.destroy();
          out.close();
          fs.rmSync(dest, { force: true });
          reject(new Error('cancelled'));
        });
      });
      req.on('error', reject);
    };
    follow(url, 5);
  });
}
