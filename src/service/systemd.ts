import { mkdir, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { EXIT_NOT_FOUND, type ExecResult } from './exec.js';
import { write0600 } from './files.js';
import type { ServiceContext, ServiceManager, ServiceStatus } from './types.js';

/** Nom de l'unité utilisateur (`sisyphe.service`) tel qu'on le passe à systemctl. */
export const SYSTEMD_UNIT = 'sisyphe';

const SHOW_PROPERTIES = 'ActiveState,SubState,MainPID,UnitFileState';

export type UnitInput = Pick<ServiceContext, 'nodePath' | 'scriptPath' | 'paths' | 'env'>;

/** `%` introduit un spécificateur (`%h`…) : le doubler est le seul échappement commun à toutes les directives. */
function specifiers(value: string): string {
  return value.replaceAll('%', '%%');
}

/**
 * Un mot d'unité systemd : une valeur contenant un espace ou une quote (systemd déquote `"` comme `'`)
 * est citée entre guillemets doubles, où seuls `\` et `"` s'échappent.
 */
function word(value: string): string {
  const v = specifiers(value);
  return /['\s"\\]/.test(v) ? `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : v;
}

/** Mot d'une ligne de commande : `$FOO` et `${FOO}` y sont remplacés, `$$` est le `$` littéral. */
function commandWord(value: string): string {
  return word(value.replaceAll('$', '$$$$'));
}

export function renderUnit(i: UnitInput): string {
  // `Environment=` prend des mots `CLÉ=VALEUR` : c'est l'affectation entière qu'on cite, comme la doc systemd.
  // Pas d'expansion de variables ici, donc pas de `$` doublé — il resterait tel quel dans l'environnement.
  const env = Object.entries(i.env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}`);
  return [
    '[Unit]',
    'Description=Sisyphe daemon',
    '',
    '[Service]',
    `ExecStart=${commandWord(i.nodePath)} ${commandWord(i.scriptPath)} start`,
    // Jamais de guillemets : systemd ne déquote pas cette directive et rejetterait l'unité entière
    // (chemin jugé non absolu). `paths.root` sort de `resolve()`, il est donc toujours absolu.
    `WorkingDirectory=${specifiers(i.paths.root)}`,
    ...env,
    'Restart=on-failure',
    'RestartSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface SystemctlShow {
  activeState: string;
  subState: string;
  /** 0 quand le service ne tourne pas. */
  mainPid: number;
  /** Vide (ou `not-found`) quand l'unité n'existe pas. */
  unitFileState: string;
}

/** Lit les lignes `clé=valeur` de `systemctl show -p …` (fonction pure, testable). */
export function parseSystemctlShow(stdout: string): SystemctlShow {
  const props = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const pid = Number(props.get('MainPID') ?? 0);
  return {
    activeState: props.get('ActiveState') ?? '',
    subState: props.get('SubState') ?? '',
    mainPid: Number.isFinite(pid) ? pid : 0,
    unitFileState: props.get('UnitFileState') ?? '',
  };
}

export function unitPath(homeDir: string): string {
  return join(homeDir, '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.service`);
}

function describeFailure(file: string, args: string[], r: ExecResult): string {
  return `${file} ${args.join(' ')} a échoué (code ${r.exitCode}) : ${r.stderr || r.stdout}`;
}

const NOT_INSTALLED = 'unité systemd non installée';

/** Unité systemd utilisateur (Linux) : `enable --now` / `disable --now` pilotent démarrage et relance au boot. */
export class SystemdServiceManager implements ServiceManager {
  constructor(private readonly ctx: ServiceContext) {}

  private get unit(): string {
    return unitPath(this.ctx.homeDir);
  }

  /** `systemctl --user …` ; code non nul → erreur qui cite la commande et sa sortie. */
  private async systemctl(...args: string[]): Promise<ExecResult> {
    const full = ['--user', ...args];
    const r = await this.ctx.exec('systemctl', full);
    if (r.exitCode !== 0) throw new Error(describeFailure('systemctl', full, r));
    return r;
  }

  /** Ne lève jamais : l'UI affiche un avertissement, pas une erreur. */
  async status(): Promise<ServiceStatus> {
    const args = ['--user', 'show', SYSTEMD_UNIT, '-p', SHOW_PROPERTIES];
    const r = await this.ctx.exec('systemctl', args);
    const none = { kind: 'systemd' as const, installed: false, running: false, pid: null, enabledAtBoot: false };
    if (r.exitCode !== 0) {
      return { ...none, detail: r.exitCode === EXIT_NOT_FOUND ? 'systemctl introuvable' : describeFailure('systemctl', args, r) };
    }
    const s = parseSystemctlShow(r.stdout);
    if (s.unitFileState === '' || s.unitFileState === 'not-found') return { ...none, detail: NOT_INSTALLED };
    return {
      kind: 'systemd', installed: true, running: s.activeState === 'active', pid: s.mainPid === 0 ? null : s.mainPid,
      enabledAtBoot: s.unitFileState === 'enabled', detail: `${s.activeState} (${s.subState})`,
    };
  }

  /**
   * Écrit l'unité (0600) et la fait relire ; `enable-linger` garde le gestionnaire utilisateur vivant hors
   * session — refusé, on avertit plutôt que d'échouer : le reste de l'installation est valide.
   */
  async install(): Promise<{ warnings: string[] }> {
    const p = this.unit;
    await mkdir(dirname(p), { recursive: true });
    await write0600(p, renderUnit(this.ctx));
    try {
      await this.systemctl('daemon-reload');
    } catch (err) {
      // L'unité est sur le disque mais systemd ne la connaît pas : dire comment reprendre l'installation.
      throw new Error(`${(err as Error).message}. L'unité est écrite mais non chargée : relancer « sisyphe setup --reinstall-service » une fois le problème corrigé.`);
    }
    const warnings: string[] = [];
    const linger = await this.ctx.exec('loginctl', ['enable-linger']);
    if (linger.exitCode !== 0) {
      warnings.push(`\`sudo loginctl enable-linger ${userInfo().username}\` à lancer une fois, sinon le service s'arrête à la déconnexion`);
    }
    return { warnings };
  }

  async start(): Promise<void> {
    await this.systemctl('enable', '--now', SYSTEMD_UNIT);
  }

  /** Un `stop` explicite n'est jamais relancé par `Restart=on-failure` ; `disable` retire aussi le démarrage au boot. */
  async stop(): Promise<void> {
    await this.systemctl('disable', '--now', SYSTEMD_UNIT);
  }

  /** `disable` sans se soucier du code de retour : une unité déjà absente n'a rien à désactiver. */
  async uninstall(): Promise<void> {
    await this.ctx.exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
    await rm(this.unit, { force: true });
    await this.systemctl('daemon-reload');
  }
}
