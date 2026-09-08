import { execa } from 'execa';

/** Succès partiel : un check qui aboutit mais doit s'afficher en ⚠️ sans faire basculer `ok` (ex. réseau indisponible). */
export interface CheckWarnResult {
  warn: true;
  message: string;
}

export interface Check {
  name: string;
  /** Une chaîne = succès (✅). `{ warn: true, message }` = succès dégradé (⚠️), sans lever. Lève sinon en cas d'échec. */
  run: () => Promise<string | CheckWarnResult>;
  /** Échec (levé) non bloquant : affiché en ⚠️, ne fait pas passer `ok` à false. Statique, pour tout échec du check. */
  warn?: boolean;
}

export async function runChecks(checks: Check[]): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  for (const c of checks) {
    try {
      const result = await c.run();
      if (typeof result === 'string') {
        lines.push(`✅ ${c.name} : ${result}`);
      } else {
        lines.push(`⚠️ ${c.name} : ${result.message}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (c.warn) {
        lines.push(`⚠️ ${c.name} : ${message}`);
      } else {
        ok = false;
        lines.push(`❌ ${c.name} : ${message}`);
      }
    }
  }
  return { ok, lines };
}

/** Ignore les préfixes `VAR=valeur` (`FOO=bar cmd` → `cmd`) et une première quote englobante (`"my tool" --x` → `my tool`). */
export function firstWord(command: string): string {
  let s = command.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  }
  const quoted = /^"([^"]*)"/.exec(s);
  if (quoted) return quoted[1] ?? '';
  return s.split(/\s+/)[0] ?? '';
}

export async function which(bin: string): Promise<string> {
  const r = await execa('which', [bin], { reject: false });
  if (r.exitCode !== 0) throw new Error(`${bin} introuvable sur le PATH`);
  return r.stdout.trim();
}
