export interface PlanItem {
  id: string;
  text: string;
  checked: boolean;
}

const ITEM_RE = /^\s*-\s*\[([ xX])\]\s+((?:S|A)\d+)[:：]\s*(.+?)\s*$/gm;

export function parsePlanItems(markdown: string, prefix: 'S' | 'A'): PlanItem[] {
  const result: PlanItem[] = [];
  const re = new RegExp(ITEM_RE.source, 'gm');
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown || ''))) {
    if (match[2].startsWith(prefix)) {
      result.push({ id: match[2], checked: match[1].toLowerCase() === 'x', text: match[3] });
    }
  }
  return result;
}

export function parsePlanSteps(markdown: string): PlanItem[] {
  return parsePlanItems(markdown, 'S');
}

export function parseAcceptanceCriteria(markdown: string): PlanItem[] {
  return parsePlanItems(markdown, 'A');
}

export function getPlanProgress(markdown: string): {
  steps: PlanItem[];
  acceptance: PlanItem[];
  completed: number;
  total: number;
  next?: PlanItem;
} {
  const steps = parsePlanSteps(markdown);
  const acceptance = parseAcceptanceCriteria(markdown);
  const all = [...steps, ...acceptance];
  return {
    steps,
    acceptance,
    completed: all.filter((item) => item.checked).length,
    total: all.length,
    next: all.find((item) => !item.checked),
  };
}
