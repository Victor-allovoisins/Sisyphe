import { execa } from 'execa';
import { readFile, statfs } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { createApp, machineConfigPath, type App } from '../../app.js';
import { loadMachineConfig, MachineConfigError, type MachineConfig } from '../../config/machine.js';
import { dataPaths, type DataPaths } from '../../config/paths.js';
import { REPO_CONFIG_FILENAME, parseRepoConfig } from '../../config/repo.js';
import { assertSocketPathLength, MAX_SOCKET_PATH_BYTES } from '../../daemon/control.js';
import { parseRepo, type RepoRef } from '../../github/source.js';
import { isStaleLaunchAgentPlist, plistPath, STALE_PLIST_MESSAGE } from '../../service/launchd.js';
import type { ServiceStatus } from '../../service/index.js';
import { firstWord, runChecks, which, whichOrHint, withHint, type Check } from '../checks.js';
import { serviceManagerFor } from './service.js';

const BYTES_PER_GB = 1024 ** 3;
const MIN_FREE_DISK_GB = 10;

/** Le sous-ensemble de GitHubIssueSource dont doctor a besoin : facilite le test avec un faux client. */
export interface DoctorGitHub {
  checkAccess(): Promise<{ appSlug: string; repos: string[] }>;
  getFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null>;
}

/** Le sous-ensemble du ServiceManager dont doctor a besoin : un test passe un faux, jamais launchd ni systemd. */
export interface DoctorService {
  status(): Promise<ServiceStatus>;
}

export interface BuildChecksInput {
  machine?: MachineConfig;
  github?: DoctorGitHub;
  env: NodeJS.ProcessEnv;
  paths?: DataPaths;
  /** Absent (config illisible) : aucun check « service ». */
  service?: DoctorService;
  /** Injectable pour les tests ; par défaut process.versions.node. */
  nodeVersion?: string;
  /** Décide des consignes d'installation, du check caffeinate (macOS) et du check linger (Linux). */
  platform?: NodeJS.Platform;
  /** Plist de l'agent launchd inspecté par le check « service » ; injectable pour ne jamais lire le vrai. */
  plistPath?: string;
  /**
   * Faux : ni présence ni validité de la clé API. La page de réglages lit l'environnement de l'interface, pas
   * celui du service, et contredirait le daemon qui tourne ; `doctor` et `setup` gardent ces contrôles.
   */
  apiKeyChecks?: boolean;
}

async function checkApiKeyLive(key: string): Promise<string | { warn: true; message: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Pas de réseau, DNS, timeout... : ni une clé refusée ni un succès, on ne bloque pas doctor/setup pour ça.
    return { warn: true, message: 'réseau indisponible' };
  }
  if (res.status === 200) return 'clé valide';
  if (res.status === 429) return 'clé acceptée, rate limit';
  if (res.status === 401 || res.status === 403) throw new Error('clé refusée');
  throw new Error(`réponse HTTP ${res.status}`);
}

/**
 * Lecture de `claude auth status --json`. Seuls `loggedIn` et `authMethod` sont regardés : rien d'autre
 * du profil (email, organisation, abonnement) ne doit remonter dans la sortie de doctor.
 */
export function parseAuthStatus(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('sortie de `claude auth status --json` illisible');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('sortie de `claude auth status --json` inattendue');
  const status = parsed as { loggedIn?: unknown; authMethod?: unknown };
  if (status.loggedIn !== true) throw new Error('non connecté : lancer `claude login`');
  return typeof status.authMethod === 'string' ? `connecté (${status.authMethod})` : 'connecté';
}

async function checkClaudeCli(platform: NodeJS.Platform): Promise<string> {
  await whichOrHint('claude', platform);
  const r = await execa('claude', ['--version'], { reject: false });
  if (r.exitCode !== 0) throw new Error(`\`claude --version\` a échoué (code ${r.exitCode})`);
  return r.stdout.trim();
}

async function checkClaudeAuth(): Promise<string> {
  const r = await execa('claude', ['auth', 'status', '--json'], { reject: false });
  if (r.exitCode !== 0) throw new Error('`claude auth status` a échoué : lancer `claude login`');
  return parseAuthStatus(r.stdout);
}

async function checkCodexCli(platform: NodeJS.Platform): Promise<string> {
  await whichOrHint('codex', platform);
  const r = await execa('codex', ['--version'], { reject: false });
  if (r.exitCode !== 0) throw new Error(`\`codex --version\` a échoué (code ${r.exitCode})`);
  return r.stdout.trim();
}

/** `codex login status` (épinglé) : un code de sortie 0 = connecté ; la ligne « Logged in using … » suffit. */
async function checkCodexAuth(): Promise<string> {
  const r = await execa('codex', ['login', 'status'], { reject: false });
  if (r.exitCode !== 0) throw new Error('`codex login status` a échoué : lancer `codex login`');
  return r.stdout.trim() || 'connecté';
}

/**
 * Lecture de `opencode auth list` (épinglé). La sortie réelle est un encadré colorisé qui ne se prête pas
 * à l'affichage doctor : on retire l'ANSI et on résume le nombre de fournisseurs (« 8 credentials »).
 * Aucun identifiant → échec nommant la commande de login ; forme inattendue non vide → « connecté ».
 */
export function parseOpenCodeAuthStatus(stdout: string): string {
  const clean = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const count = /(\d+)\s+credentials?/i.exec(clean);
  if (count) {
    const n = Number(count[1]);
    if (n === 0) throw new Error('aucun identifiant : lancer `opencode auth login`');
    return `${n} fournisseur(s) connecté(s)`;
  }
  if (clean === '') throw new Error('`opencode auth list` n’a rien renvoyé : lancer `opencode auth login`');
  return 'connecté';
}

async function checkOpencodeCli(platform: NodeJS.Platform): Promise<string> {
  await whichOrHint('opencode', platform);
  const r = await execa('opencode', ['--version'], { reject: false });
  if (r.exitCode !== 0) throw new Error(`\`opencode --version\` a échoué (code ${r.exitCode})`);
  return r.stdout.trim();
}

async function checkOpencodeAuth(): Promise<string> {
  const r = await execa('opencode', ['auth', 'list'], { reject: false });
  if (r.exitCode !== 0) throw new Error('`opencode auth list` a échoué : lancer `opencode auth login`');
  return parseOpenCodeAuthStatus(r.stdout);
}

async function checkDiskSpace(root: string): Promise<string> {
  const s = await statfs(root);
  const freeGb = (s.bavail * s.bsize) / BYTES_PER_GB;
  if (freeGb < MIN_FREE_DISK_GB) throw new Error(`${freeGb.toFixed(1)} Go libres (< ${MIN_FREE_DISK_GB} Go)`);
  return `${freeGb.toFixed(1)} Go libres`;
}

/**
 * État du service. Un service absent ou un daemon arrêté est un avertissement, pas une panne — d'où la
 * forme `{ warn }` plutôt qu'un `throw`, réservé ici aux vraies pannes : sonde en erreur, ou agent launchd
 * obsolète, qui fait mentir tout le reste de la ligne (« au boot » et l'arrêt lui-même).
 */
async function checkService(service: DoctorService, plist: string): Promise<string | { warn: true; message: string }> {
  const s = await service.status();
  // `none` : rien n'est installable ici, inutile de conseiller une réinstallation.
  if (s.kind === 'none') return { warn: true, message: `aucun service géré sur cette plateforme (${s.detail})` };
  if (!s.installed) return { warn: true, message: `${s.kind} : non installé — lancer \`sisyphe setup --reinstall-service\`` };
  if (s.kind === 'launchd') await assertFreshLaunchAgent(plist);
  const boot = s.enabledAtBoot ? 'oui' : 'non';
  return `${s.kind}, ${s.running ? `actif (pid ${s.pid ?? '?'})` : 'arrêté'}, au boot : ${boot} · ${s.detail}`;
}

/**
 * Lève si le plist installé vient d'une version antérieure. Plist illisible (absent, droits) : aucun verdict
 * — « sans `PathState` » doit vouloir dire « lu, et la clé n'y est pas », jamais « pas pu lire ».
 */
async function assertFreshLaunchAgent(plist: string): Promise<void> {
  const text = await readFile(plist, 'utf8').catch(() => null);
  if (text !== null && isStaleLaunchAgentPlist(text)) throw new Error(STALE_PLIST_MESSAGE);
}

/**
 * Sans linger, systemd tue les services utilisateur à la déconnexion : le daemon ne survivrait ni à un
 * `exit` de session SSH ni à un redémarrage. Avertissement seulement, l'installation reste utilisable en session.
 */
async function checkLinger(): Promise<string> {
  const user = userInfo().username;
  const r = await execa('loginctl', ['show-user', user, '-p', 'Linger'], { reject: false });
  if (r.exitCode !== 0) throw new Error(`\`loginctl show-user ${user} -p Linger\` a échoué : linger inconnu`);
  if (!/^Linger=yes$/m.test(r.stdout.trim())) {
    throw new Error(`désactivé : le service s'arrête à la déconnexion — \`sudo loginctl enable-linger ${user}\``);
  }
  return 'activé';
}

/** Construit la liste des checks, sans en exécuter aucun (fonction pure côté construction). */
export function buildChecks(input: BuildChecksInput): Check[] {
  const platform = input.platform ?? process.platform;
  const checks: Check[] = [
    {
      name: 'node',
      run: async () => {
        const version = input.nodeVersion ?? process.versions.node;
        const major = Number(version.split('.')[0]);
        if (major < 24) withHint(`Node ${version}, il faut 24 ou plus`, 'node', platform);
        return version;
      },
    },
    { name: 'git', run: () => whichOrHint('git', platform) },
    { name: 'gitleaks', run: () => whichOrHint('gitleaks', platform) },
    {
      name: 'config machine',
      run: async () => {
        const c = await loadMachineConfig(machineConfigPath());
        return `${machineConfigPath()} · ${c.repos.length} repo(s)`;
      },
    },
  ];

  // `caffeinate` est un outil macOS : ailleurs, le daemon n'a aucune veille à empêcher.
  if (platform === 'darwin') checks.push({ name: 'caffeinate', warn: true, run: () => which('caffeinate') });

  // Checks adaptés au backend : la CLI locale et sa session remplacent la clé API pour `claude-code`,
  // `codex` et `opencode`. Config absente ou illisible (machine indéfinie) : on reste sur le défaut du
  // schéma, `sdk`, et les checks de clé API ne concernent que lui.
  const backend = input.machine?.agentBackend ?? 'sdk';
  if (backend === 'claude-code') {
    checks.push({ name: 'claude (CLI)', run: () => checkClaudeCli(platform) });
    checks.push({ name: 'claude auth status', run: checkClaudeAuth });
  } else if (backend === 'codex') {
    checks.push({ name: 'codex (CLI)', run: () => checkCodexCli(platform) });
    checks.push({ name: 'codex login status', run: checkCodexAuth });
  } else if (backend === 'opencode') {
    checks.push({ name: 'opencode (CLI)', run: () => checkOpencodeCli(platform) });
    checks.push({ name: 'opencode auth list', run: checkOpencodeAuth });
  } else if (input.apiKeyChecks !== false) {
    checks.push({
      name: 'ANTHROPIC_API_KEY',
      run: async () => {
        if (!input.env.ANTHROPIC_API_KEY) throw new Error("absente de l'environnement");
        return 'présente';
      },
    });
    // Absente : le check de présence ci-dessus suffit, inutile d'appeler le réseau pour rien.
    const apiKey = input.env.ANTHROPIC_API_KEY;
    if (apiKey) checks.push({ name: 'clé API (appel minimal)', run: () => checkApiKeyLive(apiKey) });
  }

  const { paths } = input;
  if (paths) {
    checks.push({ name: 'espace disque', warn: true, run: () => checkDiskSpace(paths.root) });
    // Une racine de données trop profonde rend la socket de contrôle impossible à ouvrir. Sans ce check,
    // on ne l'apprend qu'au démarrage du daemon — que le service relance ensuite toutes les 30 s, sans fin.
    checks.push({
      name: 'socket de contrôle',
      run: async () => {
        assertSocketPathLength(paths.controlSocketPath);
        return `${Buffer.byteLength(paths.controlSocketPath, 'utf8')} octets sur ${MAX_SOCKET_PATH_BYTES}`;
      },
    });
  }

  const { service } = input;
  // Sans `warn: true` : une sonde en panne ou un agent launchd obsolète sont des échecs (❌), pas des
  // détails. Les cas non bloquants (rien d'installé, plateforme sans service) passent par `{ warn }`.
  if (service) {
    const plist = input.plistPath ?? plistPath();
    checks.push({ name: 'service', run: () => checkService(service, plist) });
  }
  if (platform === 'linux') checks.push({ name: 'linger', warn: true, run: checkLinger });

  if (input.machine && input.github) {
    const machine = input.machine;
    const github = input.github;
    checks.push({
      name: 'GitHub App',
      run: async () => {
        const access = await github.checkAccess();
        const missing = machine.repos.filter((r) => !access.repos.includes(r));
        if (missing.length) throw new Error(`l'installation n'a pas accès à : ${missing.join(', ')}`);
        return `${access.appSlug}, accès à ${access.repos.length} repo(s)`;
      },
    });
    for (const full of machine.repos) {
      const repo = parseRepo(full);
      checks.push({
        name: `${full} · ${REPO_CONFIG_FILENAME}`,
        run: async () => {
          const text = await github.getFileContent(repo, REPO_CONFIG_FILENAME);
          if (text === null) throw new Error('absent sur la branche par défaut');
          const cfg = parseRepoConfig(text);
          const bins = [...new Set([cfg.commands.setup, cfg.commands.build, cfg.commands.test, cfg.commands.lint].filter((c): c is string => !!c).map(firstWord))];
          for (const b of bins) await which(b);
          return `base ${cfg.baseBranch}, outils : ${bins.join(', ')}`;
        },
      });
    }
  }

  return checks;
}

export async function doctorCommand(): Promise<void> {
  let app: App | null = null;
  let initError: unknown = null;
  try {
    app = await createApp({ needsAgent: false });
  } catch (err) {
    initError = err;
  }

  // L'init peut échouer après la config (client GitHub, par exemple) : on relit la config seule pour
  // savoir quel backend agent vérifier, sinon doctor retomberait à tort sur les checks de clé API.
  const machine = app?.machine ?? (await loadMachineConfig(machineConfigPath()).catch(() => undefined));
  // Sans config, ni racine de données ni gestionnaire de service : le check « config machine » dit déjà tout.
  const paths = app?.paths ?? (machine ? dataPaths(machine.dataDir) : undefined);
  const service = machine && paths ? await serviceManagerFor(paths, machine) : undefined;
  const checks = buildChecks({ machine, github: app?.github, env: process.env, paths, service });

  // La config invalide est déjà signalée par le check « config machine » : ne pas la répéter ici.
  if (initError && !(initError instanceof MachineConfigError)) {
    const err = initError;
    checks.push({ name: 'initialisation', run: async () => { throw err; } });
  }

  const { ok, lines } = await runChecks(checks);
  console.log(lines.join('\n'));
  if (!ok) process.exitCode = 1;
}
