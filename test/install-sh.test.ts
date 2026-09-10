import { execa } from 'execa';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tests d'`install.sh`. Tout passe par `--dry-run` sauf l'analyse syntaxique : aucune commande
 * d'installation n'est exécutée, aucun accès réseau, et `HOME` pointe sur un `mkdtemp` pour que
 * la logique de profil reste sans effet sur la machine.
 *
 * Le `PATH` est réduit au répertoire de faux outils : le script ne doit voir que ce qu'on lui
 * donne. Quelques utilitaires réels (`grep`, `sed`, `head`) y sont liés, car le script les
 * utilise pour lire un profil ou une réponse d'API — jamais pour détecter un outil.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, 'install.sh');
const SYSTEM_UTILS = ['grep', 'sed', 'head'];

/** Faux exécutable : un script `sh` qui répond ce qu'on veut à la détection. */
interface Fakes {
  [name: string]: string;
}

/** Chemin réel d'un utilitaire, ou chaîne vide s'il est absent de la machine. */
async function locate(name: string): Promise<string> {
  const r = await execa('/bin/sh', ['-c', `command -v ${name}`], { reject: false });
  return (r.stdout ?? '').trim();
}

async function makeBin(fakes: Fakes): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sisyphe-inst-bin-'));
  for (const util of SYSTEM_UTILS) {
    const real = await locate(util);
    if (real) await symlink(real, join(dir, util));
  }
  for (const [name, body] of Object.entries(fakes)) {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
  }
  return dir;
}

interface RunOptions {
  os?: string;
  fakes?: Fakes;
  args?: string[];
  home?: string;
  cwd?: string;
  shell?: string;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Les seules lignes que les tests inspectent : une commande émise par `run`. */
  commands: string[];
}

async function runInstall(options: RunOptions = {}): Promise<RunResult> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'sisyphe-inst-home-')));
  const bin = await makeBin(options.fakes ?? {});
  const r = await execa(options.shell ?? '/bin/sh', [SCRIPT, '--dry-run', ...(options.args ?? [])], {
    cwd: options.cwd ?? REPO,
    env: { HOME: home, PATH: bin, SISYPHE_INSTALL_OS: options.os ?? 'darwin' },
    extendEnv: false,
    reject: false,
  });
  const stdout = r.stdout ?? '';
  return {
    exitCode: r.exitCode ?? -1,
    stdout,
    stderr: r.stderr ?? '',
    commands: stdout.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2)),
  };
}

/** Vérifie que chaque motif apparaît, dans l'ordre, parmi les commandes émises. */
function expectOrder(commands: string[], patterns: (string | RegExp)[]): void {
  let from = 0;
  for (const pattern of patterns) {
    const found = commands.findIndex(
      (c, i) => i >= from && (typeof pattern === 'string' ? c.includes(pattern) : pattern.test(c)),
    );
    expect(found, `« ${String(pattern)} » attendu après l'index ${from} dans :\n${commands.join('\n')}`).toBeGreaterThanOrEqual(from);
    from = found + 1;
  }
}

/** Faux outils déjà installés : rien à poser, seulement le build. */
const allPresent: Fakes = {
  git: 'case "$1" in remote) ;; *) ;; esac',
  node: 'echo v24.0.0',
  npm: 'case "$*" in "prefix -g") echo "$HOME" ;; esac',
  gitleaks: 'exit 0',
  claude: 'echo \'{"loggedIn":true}\'',
};

describe('install.sh', () => {
  it('est syntaxiquement valide en sh POSIX', async () => {
    const r = await execa('/bin/sh', ['-n', SCRIPT], { reject: false });
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
  });

  it('est syntaxiquement valide sous dash (pas de bashisme)', async () => {
    const dash = await locate('dash');
    if (!dash) return; // pas de dash sur la machine : rien à vérifier
    const r = await execa(dash, ['-n', SCRIPT], { reject: false });
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
  });

  it('macOS sans aucun outil : brew pour git, node et gitleaks, puis npm et setup', async () => {
    const r = await runInstall({ os: 'darwin', fakes: { brew: 'exit 0' } });
    expect(r.exitCode).toBe(0);
    expectOrder(r.commands, [
      'brew install git',
      'brew install node',
      'brew install gitleaks',
      'npm install -g @anthropic-ai/claude-code',
      'npm ci',
      'npm run build',
      'npm link',
      'sisyphe setup',
    ]);
  });

  it('macOS sans Homebrew : message avec la commande officielle et sortie en erreur', async () => {
    const r = await runInstall({ os: 'darwin' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Homebrew');
    expect(r.stderr).toContain('raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
    expect(r.commands).toEqual([]);
  });

  it('macOS avec un node trop ancien : brew upgrade node', async () => {
    const r = await runInstall({ os: 'darwin', fakes: { brew: 'exit 0', node: 'echo v20.11.1' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands).toContain('brew upgrade node');
    expect(r.commands).not.toContain('brew install node');
  });

  it('Ubuntu sans aucun outil : apt, NodeSource, release gitleaks vérifiée, puis npm et setup', async () => {
    const r = await runInstall({ os: 'ubuntu', fakes: { uname: 'case "$1" in -m) echo x86_64 ;; -s) echo Linux ;; esac' } });
    expect(r.exitCode).toBe(0);
    expectOrder(r.commands, [
      'sudo apt-get install -y git',
      'https://deb.nodesource.com/setup_24.x',
      /^sudo -E bash \/.*nodesource.*\.sh$/,
      'sudo apt-get install -y nodejs',
      'https://api.github.com/repos/gitleaks/gitleaks/releases/latest',
      /gitleaks_.+_linux_x64\.tar\.gz$/,
      'checksums.txt https://github.com/gitleaks/gitleaks/releases/download/',
      'sha256sum --ignore-missing -c checksums.txt',
      /^tar -xzf .*gitleaks_.+_linux_x64\.tar\.gz -C .* gitleaks$/,
      /^install -m 0755 .*\/gitleaks .*\/\.local\/bin\/gitleaks$/,
      /\.profile"$/,
      'npm install -g @anthropic-ai/claude-code',
      'npm ci',
      'npm run build',
      'npm link',
      'sisyphe setup',
    ]);
    // Le script téléchargé n'est jamais exécuté directement depuis un tube.
    expect(r.commands.some((c) => c.includes('|'))).toBe(false);
  });

  it('Ubuntu sur ARM : archive gitleaks linux_arm64', async () => {
    const r = await runInstall({ os: 'ubuntu', fakes: { uname: 'case "$1" in -m) echo aarch64 ;; -s) echo Linux ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => /gitleaks_.+_linux_arm64\.tar\.gz$/.test(c))).toBe(true);
  });

  it('tous les outils déjà présents : seulement le build, le lien et le setup', async () => {
    const r = await runInstall({ os: 'darwin', fakes: allPresent });
    expect(r.exitCode).toBe(0);
    expect(r.commands).toEqual(['npm ci', 'npm run build', 'npm link', 'sisyphe setup']);
  });

  it('--no-setup et --no-pull sont respectés', async () => {
    const fakes: Fakes = { ...allPresent, git: 'case "$1" in remote) echo origin ;; esac' };
    const r = await runInstall({ os: 'darwin', fakes, args: ['--no-setup', '--no-pull'] });
    expect(r.exitCode).toBe(0);
    expect(r.commands).toEqual(['npm ci', 'npm run build', 'npm link']);
  });

  it('clone avec un distant et un arbre propre : git pull --ff-only avant le build', async () => {
    const fakes: Fakes = { ...allPresent, git: 'case "$1" in remote) echo origin ;; esac' };
    const r = await runInstall({ os: 'darwin', fakes });
    expect(r.exitCode).toBe(0);
    expectOrder(r.commands, ['git pull --ff-only', 'npm ci']);
  });

  it('clone sans distant : aucun git pull et aucun échec', async () => {
    const r = await runInstall({ os: 'darwin', fakes: allPresent });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => c.startsWith('git pull'))).toBe(false);
    expect(r.stdout).toContain('aucun dépôt distant');
  });

  it('arbre de travail modifié : aucun git pull', async () => {
    const fakes: Fakes = {
      ...allPresent,
      git: 'case "$1" in remote) echo origin ;; status) echo " M src/x.ts" ;; esac',
    };
    const r = await runInstall({ os: 'darwin', fakes });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => c.startsWith('git pull'))).toBe(false);
  });

  it('préfixe npm global non inscriptible : bascule sur un préfixe utilisateur avant toute installation globale', async () => {
    const readOnly = await mkdtemp(join(tmpdir(), 'sisyphe-inst-prefix-'));
    await chmod(readOnly, 0o555);
    const fakes: Fakes = { brew: 'exit 0', npm: `case "$*" in "prefix -g") echo "${readOnly}" ;; esac` };
    const r = await runInstall({ os: 'darwin', fakes });
    expect(r.exitCode).toBe(0);
    expectOrder(r.commands, [
      /^npm config set prefix .*\/\.local$/,
      /\.profile"$/,
      'npm install -g @anthropic-ai/claude-code',
      'npm link',
    ]);
    // Aucune installation npm sous sudo.
    expect(r.commands.some((c) => c.startsWith('sudo') && c.includes('npm'))).toBe(false);
  });

  it('préfixe npm inscriptible : ni bascule de préfixe ni ligne de profil', async () => {
    const r = await runInstall({ os: 'darwin', fakes: { brew: 'exit 0', npm: 'case "$*" in "prefix -g") echo "$HOME" ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => c.includes('npm config set prefix'))).toBe(false);
    expect(r.commands.some((c) => c.includes('.profile'))).toBe(false);
  });

  it('profil contenant déjà la ligne PATH : rien n est ajouté', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sisyphe-inst-home-'));
    await writeFile(join(home, '.profile'), '# perso\nexport PATH="$HOME/.local/bin:$PATH"\n');
    const r = await runInstall({ os: 'ubuntu', home, fakes: { uname: 'case "$1" in -m) echo x86_64 ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => c.includes('.profile'))).toBe(false);
    expect(r.stdout).toContain('contient déjà la ligne PATH');
  });

  it('système non géré : message et sortie en erreur', async () => {
    const r = await runInstall({ os: 'freebsd' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Système non géré : freebsd');
    expect(r.stderr).toContain('SISYPHE_INSTALL_OS=darwin|ubuntu');
    expect(r.commands).toEqual([]);
  });

  it('appelé depuis un autre répertoire : travaille dans le répertoire du script', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'sisyphe-inst-cwd-'));
    await mkdir(join(elsewhere, 'sous-dossier'));
    const r = await runInstall({ os: 'darwin', fakes: allPresent, cwd: join(elsewhere, 'sous-dossier') });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`répertoire : ${REPO}`);
  });

  it('option inconnue : aide et code 2', async () => {
    const r = await runInstall({ os: 'darwin', args: ['--wat'] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Option inconnue : --wat');
    expect(r.stderr).toContain('Usage');
  });

  it('exécution complète sous dash : mêmes commandes que sous sh', async () => {
    const dash = await locate('dash');
    if (!dash) return;
    const sh = await runInstall({ os: 'ubuntu', fakes: { uname: 'case "$1" in -m) echo x86_64 ;; esac' } });
    const withDash = await runInstall({ os: 'ubuntu', fakes: { uname: 'case "$1" in -m) echo x86_64 ;; esac' }, shell: dash });
    expect(withDash.exitCode).toBe(0);
    // Les chemins temporaires portent le pid : on compare les commandes normalisées.
    const normalise = (cs: string[]) => cs.map((c) => c.replace(/sisyphe-(nodesource|gitleaks)-\d+/g, 'sisyphe-$1-PID').replace(/sisyphe-inst-home-\w+/g, 'HOME'));
    expect(normalise(withDash.commands)).toEqual(normalise(sh.commands));
  });
});
