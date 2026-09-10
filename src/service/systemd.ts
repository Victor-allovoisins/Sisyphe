import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EXIT_NOT_FOUND, type ExecResult } from './exec.js';
import type { ServiceContext, ServiceManager, ServiceStatus } from './types.js';

/** Nom de l'unité utilisateur (`sisyphe.service`) tel qu'on le passe à systemctl. */
export const SYSTEMD_UNIT = 'sisyphe';

const SHOW_PROPERTIES = 'ActiveState,SubState,MainPID,UnitFileState';

export type UnitInput = Pick<ServiceContext, 'nodePath' | 'scriptPath' | 'paths' | 'env'>;

/**
 * Un mot d'unité systemd : `%` est un spécificateur (`%h`…), donc doublé ; une valeur avec espace,
 * guillemet ou antislash est citée entre guillemets doubles, seuls `\` et `"` s'y échappent.
 */
function word(value: string): string {
  const v = value.replaceAll('%', '%%');
  return /[\s"\\]/.test(v) ? `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : v;
}

export function renderUnit(i: UnitInput): string {
  // `Environment=` prend des mots `CLÉ=VALEUR` : c'est l'affectation entière qu'on cite, comme la doc systemd.
  const env = Object.entries(i.env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}`);
  return [
    '[Unit]',
    'Description=Sisyphe daemon',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${word(i.nodePath)} ${word(i.scriptPath)} start`,
    `WorkingDirectory=${word(i.paths.root)}`,
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
    // `writeFile(mode)` n'est appliqué qu'à la création : une unité déjà présente garde ses permissions sans le chmod.
    await writeFile(p, renderUnit(this.ctx), { mode: 0o600 });
    await chmod(p, 0o600);
    await this.systemctl('daemon-reload');
    const warnings: string[] = [];
    const linger = await this.ctx.exec('loginctl', ['enable-linger']);
    if (linger.exitCode !== 0) {
      const user = basename(this.ctx.homeDir);
      warnings.push(`\`sudo loginctl enable-linger ${user}\` à lancer une fois, sinon le service s'arrête à la déconnexion`);
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
