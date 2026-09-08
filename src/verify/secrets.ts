import { execa } from 'execa';
import { readFile } from 'node:fs/promises';

export interface SecretFinding {
  /** Fichier réel du repo (résolu depuis les en-têtes `+++ b/` du patch). */
  file: string;
  ruleId: string;
  /** Ligne dans le patch. */
  line: number;
}

export interface ScanOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export type GitleaksRunner = (patchFile: string, reportFile: string, opts: ScanOptions) => Promise<{ exitCode: number; output: string }>;

/** Code de sortie demandé à gitleaks quand il trouve une fuite, pour le distinguer d'une erreur (1). */
export const LEAK_EXIT_CODE = 2;

export const runGitleaks: GitleaksRunner = async (patchFile, reportFile, opts) => {
  const r = await execa(
    'gitleaks',
    ['dir', patchFile, '--no-banner', '--exit-code', String(LEAK_EXIT_CODE), '--report-format', 'json', '--report-path', reportFile],
    { reject: false, all: true, timeout: opts.timeoutMs, cancelSignal: opts.signal },
  );
  // `message` porte « Command failed with ENOENT » quand gitleaks n'est pas installé.
  return { exitCode: r.exitCode ?? -1, output: r.all || r.message || '' };
};

export class SecretScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretScanError';
  }
}

interface RawFinding {
  file: string;
  ruleId: string;
  line: number;
}

export function parseGitleaksReport(json: string): RawFinding[] {
  const raw: unknown = JSON.parse(json.trim() || '[]');
  if (!Array.isArray(raw)) throw new SecretScanError('rapport gitleaks inattendu : pas un tableau');
  return (raw as Array<{ File?: string; RuleID?: string; StartLine?: number }>).map((f) => ({ file: f.File ?? '?', ruleId: f.RuleID ?? '?', line: f.StartLine ?? 0 }));
}

/** Fichier réel auquel appartient une ligne du patch, via les en-têtes `+++ b/…` (chemins git entre guillemets acceptés) ; null avant le premier en-tête ou pour un fichier supprimé. */
export function fileAtPatchLine(patchText: string, line: number): string | null {
  const lines = patchText.split('\n');
  let current: string | null = null;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const l = lines[i];
    if (l.startsWith('+++ /dev/null')) current = null;
    else {
      const m = /^\+\+\+ "?b\/(.+?)"?$/.exec(l);
      if (m) current = m[1];
    }
  }
  return current;
}

/** Une ligne du patch est-elle une addition (`+` hors en-tête `+++`) ? */
export function isAddedLine(patchText: string, line: number): boolean {
  const l = patchText.split('\n')[line - 1];
  return l !== undefined && l.startsWith('+') && !l.startsWith('+++ ');
}

/**
 * Scanne le patch et ne retient que les secrets sur des lignes ajoutées : un secret déjà présent
 * dans le repo (ligne de contexte ou supprimée) n'est pas l'œuvre de l'agent et ne doit pas bloquer le job.
 */
export async function scanPatch(patchFile: string, reportFile: string, opts: ScanOptions, run: GitleaksRunner = runGitleaks): Promise<SecretFinding[]> {
  const { exitCode, output } = await run(patchFile, reportFile, opts);
  if (exitCode === 0) return [];
  if (exitCode !== LEAK_EXIT_CODE) throw new SecretScanError(`gitleaks a échoué (code ${exitCode}) : ${output.slice(-500)}`);
  let report: string;
  try {
    report = await readFile(reportFile, 'utf8');
  } catch (err) {
    throw new SecretScanError(`rapport gitleaks illisible : ${(err as Error).message}`);
  }
  const patchText = await readFile(patchFile, 'utf8');
  return parseGitleaksReport(report)
    .filter((f) => isAddedLine(patchText, f.line))
    .map((f) => ({ file: fileAtPatchLine(patchText, f.line) ?? f.file, ruleId: f.ruleId, line: f.line }));
}
