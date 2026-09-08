import { execa } from 'execa';
import { readFile } from 'node:fs/promises';

export interface SecretFinding {
  file: string;
  ruleId: string;
  line: number;
}

export type GitleaksRunner = (patchFile: string, reportFile: string) => Promise<{ exitCode: number; output: string }>;

/** Code de sortie demandé à gitleaks quand il trouve une fuite, pour le distinguer d'une erreur. */
export const LEAK_EXIT_CODE = 2;

export const runGitleaks: GitleaksRunner = async (patchFile, reportFile) => {
  const r = await execa(
    'gitleaks',
    ['dir', patchFile, '--no-banner', '--exit-code', String(LEAK_EXIT_CODE), '--report-format', 'json', '--report-path', reportFile],
    { reject: false, all: true },
  );
  return { exitCode: r.exitCode ?? -1, output: r.all ?? '' };
};

export class SecretScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretScanError';
  }
}

export function parseGitleaksReport(json: string): SecretFinding[] {
  const raw = JSON.parse(json.trim() || '[]') as Array<{ File?: string; RuleID?: string; StartLine?: number }>;
  return raw.map((f) => ({ file: f.File ?? '?', ruleId: f.RuleID ?? '?', line: f.StartLine ?? 0 }));
}

/** Le patch est scanné comme un fichier : on retrouve le fichier réel via les en-têtes `+++ b/`. */
export function fileAtPatchLine(patchText: string, line: number): string | null {
  const lines = patchText.split('\n');
  let current: string | null = null;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const m = /^\+\+\+ b\/(.+)$/.exec(lines[i]);
    if (m) current = m[1];
  }
  return current;
}

export async function scanPatch(patchFile: string, reportFile: string, run: GitleaksRunner = runGitleaks): Promise<SecretFinding[]> {
  const { exitCode, output } = await run(patchFile, reportFile);
  if (exitCode === 0) return [];
  if (exitCode === LEAK_EXIT_CODE) return parseGitleaksReport(await readFile(reportFile, 'utf8'));
  throw new SecretScanError(`gitleaks a échoué (code ${exitCode}) : ${output.slice(-500)}`);
}
