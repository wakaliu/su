/**
 * Shared Chat core used by the IDE side-bar webview and the Agent Window panel.
 * Keep session/send logic in ChatViewProvider; reuse these modules from both surfaces.
 */
export { runAskWithTools } from './askRunner';
export { listAtMentionItems } from './atMentions';
export { buildUserTurn, resolveDroppedUris } from './attachments';
export type { ChatAttachment } from './attachments';
export { loadWorkspaceRulesFragment } from './rulesCatalog';
export { listInstalledSkills, loadSkillById } from './skillsCatalog';
export { buildWorkspaceContextSnippet } from './workspaceContext';
export { runAgent } from '../agent/agentRunner';
