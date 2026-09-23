import * as vscode from 'vscode';
import { getModelCatalog, getSuConfig } from './config';

/**
 * Interactive editor for `su.models` (extra model ids under the same relay/key).
 */
export async function editModelList(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('su');
  const defaultModel = (cfg.get<string>('model', 'gpt-4o-mini') || 'gpt-4o-mini').trim();

  for (;;) {
    const extras = (cfg.get<string[]>('models', []) || [])
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .filter((m) => m.length > 0);
    const catalog = getModelCatalog(getSuConfig());

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(add) 添加模型…',
          description: '写入 su.models',
          action: 'add' as const,
        },
        {
          label: '$(edit) 批量编辑（逗号分隔）…',
          description: extras.join(', ') || '（当前为空）',
          action: 'bulk' as const,
        },
        {
          label: '$(settings-gear) 打开设置：Su › Models',
          description: '在设置 UI 中增删列表项',
          action: 'settings' as const,
        },
        {
          label: `$(star) 默认模型（Auto）: ${defaultModel}`,
          description: '改 su.model — 点此项打开设置',
          action: 'default' as const,
        },
        ...extras.map((id) => ({
          label: `$(trash) ${id}`,
          description: '从列表移除',
          action: 'remove' as const,
          id,
        })),
      ],
      {
        title: `Su 模型列表（Chat 可选 Auto 或：${catalog.join(' / ')}）`,
        placeHolder: '添加 / 删除额外模型；与中转、API Key 共用',
      },
    );

    if (!pick) {
      return;
    }

    if (pick.action === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@id:su.models');
      return;
    }
    if (pick.action === 'default') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@id:su.model');
      return;
    }
    if (pick.action === 'add') {
      const id = await vscode.window.showInputBox({
        title: '添加模型',
        prompt: '输入中转上的模型 id（例：glm-4.5、gpt-4o）',
        placeHolder: 'model-id',
        validateInput: (v) => {
          const t = v.trim();
          if (!t) {
            return '不能为空';
          }
          if (t === defaultModel || extras.includes(t)) {
            return '已在列表或默认模型中';
          }
          return undefined;
        },
      });
      if (!id?.trim()) {
        continue;
      }
      await cfg.update('models', [...extras, id.trim()], vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`已添加模型：${id.trim()}`);
      continue;
    }
    if (pick.action === 'bulk') {
      const raw = await vscode.window.showInputBox({
        title: '批量编辑额外模型',
        prompt: '用逗号或换行分隔多个模型 id（不含默认 su.model）',
        value: extras.join(', '),
      });
      if (raw === undefined) {
        continue;
      }
      const next = raw
        .split(/[,，\n\r]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== defaultModel);
      const unique = [...new Set(next)];
      await cfg.update('models', unique, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        unique.length ? `已更新 ${unique.length} 个额外模型。` : '额外模型列表已清空。',
      );
      continue;
    }
    if (pick.action === 'remove' && 'id' in pick && pick.id) {
      const next = extras.filter((m) => m !== pick.id);
      await cfg.update('models', next, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`已移除：${pick.id}`);
    }
  }
}
