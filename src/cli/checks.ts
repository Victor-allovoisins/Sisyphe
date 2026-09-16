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

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckView {
  name: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Exécute des contrôles et rend chaque issue en données : succès, succès dégradé `{ warn }`, échec d'un check
 * `warn: true` (avertissement), échec ordinaire. Séquentiel : certains contrôles appellent GitHub, rien ne
 * gagne à les lancer tous de front. C'est la forme de la page de réglages ; `runChecks` en tire celle du terminal.
 */
export async function checkResults(checks: Check[]): Promise<CheckView[]> {
  const results: CheckView[] = [];
  for (const c of checks) {
    try {
      const result = await c.run();
      if (typeof result === 'string') results.push({ name: c.name, status: 'ok', detail: result });
      else results.push({ name: c.name, status: 'warn', detail: result.message });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name: c.name, status: c.warn ? 'warn' : 'fail', detail });
    }
  }
  return results;
}

const STATUS_ICON: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️', fail: '❌' };

/** Forme terminal de `checkResults` (doctor, setup) : une ligne à émoji par contrôle ; `ok` tant qu'aucun n'échoue. */
export async function runChecks(checks: Check[]): Promise<{ ok: boolean; lines: string[] }> {
  const results = await checkResults(checks);
  return {
    ok: !results.some((r) => r.status === 'fail'),
    lines: results.map((r) => `${STATUS_ICON[r.status]} ${r.name} : ${r.detail}`),
  };
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

/**
 * Comment installer chaque prérequis, par plateforme. gitleaks n'est pas dans les dépôts Ubuntu : c'est le
 * lien de la release qui sert de consigne. Aucun paquet Homebrew ni apt pour la CLI Claude : npm dans les deux cas.
 */
const INSTALL_HINTS: Record<string, { darwin: string; linux: string }> = {
  node: {
    darwin: 'brew install node',
    linux: 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs',
  },
  git: { darwin: 'brew install git', linux: 'sudo apt-get install -y git' },
  gitleaks: { darwin: 'brew install gitleaks', linux: 'https://github.com/gitleaks/gitleaks/releases' },
  claude: { darwin: 'npm install -g @anthropic-ai/claude-code', linux: 'npm install -g @anthropic-ai/claude-code' },
  codex: { darwin: 'npm install -g @openai/codex', linux: 'npm install -g @openai/codex' },
  opencode: { darwin: 'npm install -g opencode-ai', linux: 'npm install -g opencode-ai' },
};

/** Commande d'installation de l'outil sur cette plateforme, `null` quand on n'a rien de sûr à conseiller. */
export function installHint(bin: string, platform: NodeJS.Platform): string | null {
  const hints = INSTALL_HINTS[bin];
  if (!hints) return null;
  if (platform === 'darwin') return hints.darwin;
  if (platform === 'linux') return hints.linux;
  return null;
}

/** `which`, mais l'échec cite la commande d'installation de la plateforme quand on en connaît une. */
export async function whichOrHint(bin: string, platform: NodeJS.Platform): Promise<string> {
  try {
    return await which(bin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return withHint(message, bin, platform);
  }
}

/** Relève un message d'échec avec la consigne d'installation ; lève toujours. */
export function withHint(message: string, bin: string, platform: NodeJS.Platform): never {
  const hint = installHint(bin, platform);
  throw new Error(hint ? `${message} — installer : ${hint}` : message);
}
