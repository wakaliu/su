export interface ToolCallSnapshot {
  name: string;
  args: string;
  result?: string;
  changed?: boolean;
}

export interface ProgressGuardOptions {
  maxNoProgressRounds: number;
  detectRepeatedTools: boolean;
}

export interface ProgressGuardResult {
  repeated: boolean;
  noProgress: boolean;
  fingerprint: string;
  repeatCount: number;
}

function stable(value: unknown): string {
  if (typeof value !== 'string') {
    return JSON.stringify(value) || '';
  }
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  } catch {
    return value.trim().replace(/\s+/g, ' ');
  }
}

export function toolFingerprint(name: string, args: string): string {
  return `${name}:${stable(args)}`;
}

/** Pure, conservative guard: repeated reads are observed, not immediately blocked. */
export class ProgressGuard {
  private readonly seen = new Map<string, number>();
  private noProgressRounds = 0;

  constructor(private readonly options: ProgressGuardOptions) {}

  observe(snapshot: ToolCallSnapshot): ProgressGuardResult {
    const fingerprint = toolFingerprint(snapshot.name, snapshot.args);
    const repeatCount = (this.seen.get(fingerprint) || 0) + 1;
    this.seen.set(fingerprint, repeatCount);
    const repeated = this.options.detectRepeatedTools && repeatCount > 1;
    if (snapshot.changed) {
      this.noProgressRounds = 0;
    } else if (repeated || snapshot.name === 'run_terminal') {
      this.noProgressRounds++;
    }
    return {
      repeated,
      noProgress: this.noProgressRounds >= Math.max(1, this.options.maxNoProgressRounds),
      fingerprint,
      repeatCount,
    };
  }

  resetProgress(): void {
    this.noProgressRounds = 0;
  }
}
