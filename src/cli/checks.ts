import { execa } from 'execa';

export interface Check {
  name: string;
  /** Renvoie un détail en cas de succès, lève en cas d'échec. */
  run: () => Promise<string>;
}

export async function runChecks(checks: Check[]): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  for (const c of checks) {
    try {
      lines.push(`✅ ${c.name} : ${await c.run()}`);
    } catch (err) {
      ok = false;
      lines.push(`❌ ${c.name} : ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok, lines };
}

export function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

export async function which(bin: string): Promise<string> {
  const r = await execa('which', [bin], { reject: false });
  if (r.exitCode !== 0) throw new Error(`${bin} introuvable sur le PATH`);
  return r.stdout.trim();
}
