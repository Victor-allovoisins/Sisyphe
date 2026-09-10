import { execa } from 'execa';
import { statfs } from 'node:fs/promises';
import { createApp, machineConfigPath, type App } from '../../app.js';
import { loadMachineConfig, MachineConfigError, type MachineConfig } from '../../config/machine.js';
import type { DataPaths } from '../../config/paths.js';
import { REPO_CONFIG_FILENAME, parseRepoConfig } from '../../config/repo.js';
import { parseRepo, type RepoRef } from '../../github/source.js';
import { firstWord, runChecks, which, type Check } from '../checks.js';
import { LAUNCHD_LABEL, parseLaunchctlPrint } from '../../service/launchd.js';

const BYTES_PER_GB = 1024 ** 3;
const MIN_FREE_DISK_GB = 10;

/** Le sous-ensemble de GitHubIssueSource dont doctor a besoin : facilite le test avec un faux client. */
export interface DoctorGitHub {
  checkAccess(): Promise<{ appSlug: string; repos: string[] }>;
  getFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null>;
}

export interface BuildChecksInput {
  machine?: MachineConfig;
  github?: DoctorGitHub;
  env: NodeJS.ProcessEnv;
  paths?: DataPaths;
  /** Injectable pour les tests ; par défaut process.versions.node. */
  nodeVersion?: string;
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

async function checkClaudeCli(): Promise<string> {
  await which('claude');
  const r = await execa('claude', ['--version'], { reject: false });
  if (r.exitCode !== 0) throw new Error(`\`claude --version\` a échoué (code ${r.exitCode})`);
  return r.stdout.trim();
}

async function checkClaudeAuth(): Promise<string> {
  const r = await execa('claude', ['auth', 'status', '--json'], { reject: false });
  if (r.exitCode !== 0) throw new Error('`claude auth status` a échoué : lancer `claude login`');
  return parseAuthStatus(r.stdout);
}

async function checkDiskSpace(root: string): Promise<string> {
  const s = await statfs(root);
  const freeGb = (s.bavail * s.bsize) / BYTES_PER_GB;
  if (freeGb < MIN_FREE_DISK_GB) throw new Error(`${freeGb.toFixed(1)} Go libres (< ${MIN_FREE_DISK_GB} Go)`);
  return `${freeGb.toFixed(1)} Go libres`;
}

async function checkLaunchdAgent(): Promise<string> {
  const uid = process.getuid?.() ?? 501;
  const r = await execa('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`], { reject: false });
  if (r.exitCode !== 0) throw new Error('agent launchd non chargé');
  const { state, lastExitCode } = parseLaunchctlPrint(r.stdout);
  // Absent (jamais lancé depuis le chargement) : ne pas inventer un code de sortie 0, ce serait un faux succès.
  if (lastExitCode === null) return `state = ${state}`;
  if (lastExitCode !== 0) throw new Error(`state = ${state}, last exit code = ${lastExitCode}`);
  return `state = ${state}, last exit code = ${lastExitCode}`;
}

/** Construit la liste des checks, sans en exécuter aucun (fonction pure côté construction). */
export function buildChecks(input: BuildChecksInput): Check[] {
  const checks: Check[] = [
    {
      name: 'node',
      run: async () => {
        const version = input.nodeVersion ?? process.versions.node;
        const major = Number(version.split('.')[0]);
        if (major < 24) throw new Error(`Node ${version}, il faut 24 ou plus`);
        return version;
      },
    },
    { name: 'git', run: () => which('git') },
    { name: 'gitleaks', run: () => which('gitleaks') },
    { name: 'caffeinate', warn: true, run: () => which('caffeinate') },
    {
      name: 'config machine',
      run: async () => {
        const c = await loadMachineConfig(machineConfigPath());
        return `${machineConfigPath()} · ${c.repos.length} repo(s)`;
      },
    },
  ];

  // Backend `cli` : c'est la CLI locale et sa session claude.ai qui remplacent la clé API.
  // Config absente ou illisible (machine indéfinie) : on reste sur le défaut du schéma, `sdk`.
  if (input.machine?.agentBackend === 'cli') {
    checks.push({ name: 'claude (CLI)', run: checkClaudeCli });
    checks.push({ name: 'claude auth status', run: checkClaudeAuth });
  } else {
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
  }

  if (process.platform === 'darwin') {
    checks.push({ name: 'agent launchd', warn: true, run: checkLaunchdAgent });
  }

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
  const checks = buildChecks({ machine, github: app?.github, env: process.env, paths: app?.paths });

  // La config invalide est déjà signalée par le check « config machine » : ne pas la répéter ici.
  if (initError && !(initError instanceof MachineConfigError)) {
    const err = initError;
    checks.push({ name: 'initialisation', run: async () => { throw err; } });
  }

  const { ok, lines } = await runChecks(checks);
  console.log(lines.join('\n'));
  if (!ok) process.exitCode = 1;
}
