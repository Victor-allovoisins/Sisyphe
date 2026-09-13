import { execa } from 'execa';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Tests d'`install.sh`. Presque tout passe par `--dry-run` : aucune commande d'installation n'est
 * exécutée, aucun accès réseau, et `HOME` pointe sur un `mkdtemp` pour que la logique de profil
 * reste sans effet sur la machine. Deux tests font exception et exécutent le script pour de vrai,
 * sur une copie dans un `mkdtemp` avec un `PATH` entièrement factice : c'est le seul moyen de
 * couvrir ce que `run` *exécute* et non ce qu'il *affiche*.
 *
 * Le `PATH` est réduit au répertoire de faux outils : le script ne doit voir que ce qu'on lui
 * donne. Quelques utilitaires réels y sont liés (`grep`, `sh`, `mktemp`, `rm`), car le script les
 * utilise pour lire un profil ou écrire un fichier — jamais pour détecter un outil.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, 'install.sh');
const SYSTEM_UTILS = ['grep', 'sh', 'mktemp', 'rm'];

/** Chemin réel d'un utilitaire, ou chaîne vide s'il est absent de la machine. */
async function locate(name: string): Promise<string> {
  const r = await execa('/bin/sh', ['-c', `command -v ${name}`], { reject: false });
  return (r.stdout ?? '').trim();
}

const DASH = await locate('dash');

/** Tous les `mkdtemp` créés ici, effacés à la fin (y compris celui en 0555). */
const created: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of created) {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Faux exécutable : un script `sh` qui répond ce qu'on veut à la détection. */
interface Fakes {
  [name: string]: string;
}

async function makeBin(fakes: Fakes, realTools: string[] = []): Promise<string> {
  const dir = await tempDir('sisyphe-inst-bin-');
  for (const util of [...SYSTEM_UTILS, ...realTools]) {
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
  realTools?: string[];
  args?: string[];
  home?: string;
  cwd?: string;
  shell?: string;
  script?: string;
  dryRun?: boolean;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Les seules lignes que les tests inspectent : une commande émise par `run`. */
  commands: string[];
}

async function runInstall(options: RunOptions = {}): Promise<RunResult> {
  const home = options.home ?? (await tempDir('sisyphe-inst-home-'));
  const bin = await makeBin(options.fakes ?? {}, options.realTools);
  const args = [...(options.dryRun === false ? [] : ['--dry-run']), ...(options.args ?? [])];
  const r = await execa(options.shell ?? '/bin/sh', [options.script ?? SCRIPT, ...args], {
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

/**
 * Faux outil qui journalise ce qu'on lui a réellement demandé : `nom|<nombre d'arguments>|<arguments>`.
 * Le nombre d'arguments distingue `run npm run build` (2) d'un `run "npm run build"` (1).
 */
function trace(name: string, log: string, body = ''): string {
  return `printf '%s|%s|%s\\n' '${name}' "$#" "$*" >> ${JSON.stringify(log)}\n${body}`;
}

function tracingFakes(log: string): Fakes {
  return {
    git: trace('git', log, 'case "$1" in remote) echo origin ;; esac'),
    node: trace('node', log, 'echo v24.0.0'),
    npm: trace('npm', log, 'case "$*" in "prefix -g") echo "$HOME" ;; esac'),
    gitleaks: trace('gitleaks', log),
    claude: trace('claude', log, 'echo \'{"loggedIn":true}\''),
    sisyphe: trace('sisyphe', log),
  };
}

async function readLog(log: string): Promise<string[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0);
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

  it.skipIf(!DASH)('est syntaxiquement valide sous dash (pas de bashisme)', async () => {
    const r = await execa(DASH, ['-n', SCRIPT], { reject: false });
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

  it('macOS avec un node trop ancien : upgrade seulement si brew a posé node', async () => {
    const r = await runInstall({ os: 'darwin', fakes: { brew: 'exit 0', node: 'echo v20.11.1' } });
    expect(r.exitCode).toBe(0);
    // Une seule ligne : brew upgrade si node vient de brew, brew install sinon
    // (un node venu de nvm ou volta ferait échouer un upgrade inconditionnel).
    expect(r.commands).toContain('brew list node >/dev/null 2>&1 && brew upgrade node || brew install node');
  });

  it('Ubuntu sans aucun outil : apt autosuffisant, NodeSource, gitleaks épinglé, puis npm et setup', async () => {
    const r = await runInstall({ os: 'ubuntu', fakes: { uname: 'case "$1" in -m) echo x86_64 ;; -s) echo Linux ;; esac' } });
    expect(r.exitCode).toBe(0);
    expectOrder(r.commands, [
      'sudo apt-get update',
      'sudo apt-get install -y git curl ca-certificates',
      'https://deb.nodesource.com/setup_24.x',
      /^sudo bash \/.*nodesource.*\.sh$/,
      'sudo apt-get install -y nodejs',
      /gitleaks_\d+\.\d+\.\d+_linux_x64\.tar\.gz$/,
      'checksums.txt https://github.com/gitleaks/gitleaks/releases/download/',
      'sha256sum --ignore-missing -c checksums.txt',
      /^tar -xzf \S+_linux_x64\.tar\.gz -C \S+ gitleaks$/,
      /^install -m 0755 \S+\/gitleaks \S+\/\.local\/bin\/gitleaks$/,
      /\.profile$/,
      'npm install -g @anthropic-ai/claude-code',
      'npm ci',
      'npm run build',
      'npm link',
      'sisyphe setup',
    ]);
    // Le script NodeSource n'est jamais exécuté depuis un tube, ni avec -E.
    expect(r.commands.some((c) => c.includes('|'))).toBe(false);
    expect(r.commands.some((c) => c.includes('sudo -E'))).toBe(false);
    // Version épinglée : aucun appel à l'API GitHub, donc pas de quota à 60/h.
    expect(r.commands.some((c) => c.includes('api.github.com'))).toBe(false);
  });

  it('Ubuntu sur ARM : archive gitleaks linux_arm64', async () => {
    const r = await runInstall({ os: 'ubuntu', fakes: { uname: 'case "$1" in -m) echo aarch64 ;; -s) echo Linux ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => /gitleaks_\d+\.\d+\.\d+_linux_arm64\.tar\.gz$/.test(c))).toBe(true);
  });

  it('tous les outils déjà présents : seulement le build, le lien et le setup', async () => {
    const r = await runInstall({ os: 'darwin', fakes: allPresent });
    expect(r.exitCode).toBe(0);
    expect(r.commands).toEqual(['npm ci', 'npm run build', 'npm link', 'sisyphe setup']);
  });

  it('configuration déjà présente : le service est réécrit, sans rien redemander', async () => {
    const home = await tempDir('sisyphe-inst-home-');
    await mkdir(join(home, '.sisyphe'), { recursive: true });
    await writeFile(join(home, '.sisyphe', 'config.yml'), 'repos: []\n');
    const r = await runInstall({ os: 'darwin', fakes: allPresent, home });
    expect(r.exitCode).toBe(0);
    // Sans cette réécriture, l'agent launchd d'une version antérieure survit à la mise à jour.
    expect(r.commands).toEqual(['npm ci', 'npm run build', 'npm link', 'sisyphe setup --reinstall-service']);
    expect(r.stdout).toContain('configuration déjà présente');
  });

  it('réinstallation du service en échec : l installation n échoue pas, la commande est rappelée', async () => {
    const dir = await tempDir('sisyphe-inst-clone-');
    const script = join(dir, 'install.sh');
    await copyFile(SCRIPT, script);
    await chmod(script, 0o755);
    const home = await tempDir('sisyphe-inst-home-');
    await mkdir(join(home, '.sisyphe'), { recursive: true });
    await writeFile(join(home, '.sisyphe', 'config.yml'), 'repos: []\n');
    const log = join(await tempDir('sisyphe-inst-log-'), 'exec.log');
    const fakes = { ...tracingFakes(log), sisyphe: `${trace('sisyphe', log)}\nexit 1` };
    const r = await runInstall({ os: 'darwin', fakes, script, home, dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('relancer « sisyphe setup --reinstall-service »');
    expect(await readLog(log)).toContain('sisyphe|2|setup --reinstall-service');
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
    const readOnly = await tempDir('sisyphe-inst-prefix-');
    await chmod(readOnly, 0o555);
    const fakes: Fakes = { brew: 'exit 0', npm: `case "$*" in "prefix -g") echo "${readOnly}" ;; esac` };
    const r = await runInstall({ os: 'darwin', fakes });
    expect(r.exitCode).toBe(0);
    expectOrder(r.commands, [
      /^npm config set prefix \S+\/\.local$/,
      /\.profile$/,
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

  it('préfixe déjà basculé sur ~/.local : la ligne de profil est revérifiée sans rebasculer', async () => {
    const r = await runInstall({ os: 'darwin', fakes: { brew: 'exit 0', npm: 'case "$*" in "prefix -g") echo "$HOME/.local" ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => c.includes('npm config set prefix'))).toBe(false);
    expect(r.commands.some((c) => /\.profile$/.test(c))).toBe(true);
  });

  it('profil contenant déjà la ligne PATH : rien n est ajouté', async () => {
    const home = await tempDir('sisyphe-inst-home-');
    await writeFile(join(home, '.profile'), '# perso\nexport PATH="$HOME/.local/bin:$PATH"\n');
    const r = await runInstall({ os: 'ubuntu', home, fakes: { uname: 'case "$1" in -m) echo x86_64 ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => c.includes('.profile'))).toBe(false);
    expect(r.stdout).toContain('contient déjà la ligne PATH');
  });

  it('shell zsh : la ligne PATH est aussi ajoutée à ~/.zprofile', async () => {
    const home = await tempDir('sisyphe-inst-home-');
    await writeFile(join(home, '.zshrc'), '# zsh\n');
    const r = await runInstall({ os: 'ubuntu', home, fakes: { uname: 'case "$1" in -m) echo x86_64 ;; esac' } });
    expect(r.exitCode).toBe(0);
    expect(r.commands.some((c) => /\.profile$/.test(c))).toBe(true);
    expect(r.commands.some((c) => /\.zprofile$/.test(c))).toBe(true);
  });

  it('système non géré : message et sortie en erreur', async () => {
    const r = await runInstall({ os: 'freebsd' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Système non géré : freebsd');
    expect(r.stderr).toContain('SISYPHE_INSTALL_OS=darwin|ubuntu');
    expect(r.commands).toEqual([]);
  });

  it('appelé depuis un autre répertoire : travaille dans le répertoire du script', async () => {
    const elsewhere = await tempDir('sisyphe-inst-cwd-');
    await mkdir(join(elsewhere, 'sous-dossier'));
    const r = await runInstall({ os: 'darwin', fakes: allPresent, cwd: join(elsewhere, 'sous-dossier') });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`répertoire : ${REPO}`);
  });

  it('option inconnue : aide, code 2, et pas de message d échec d étape', async () => {
    const r = await runInstall({ os: 'darwin', args: ['--wat'] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Option inconnue : --wat');
    expect(r.stderr).toContain('Usage');
    expect(r.stderr).not.toContain('Échec pendant');
  });

  it('un chemin avec espace ou apostrophe reste copiable-collable', async () => {
    const home = join(await tempDir('sisyphe-inst-home-'), "ho me d'o brien");
    await mkdir(home);
    const r = await runInstall({ os: 'ubuntu', home, fakes: { uname: 'case "$1" in -m) echo x86_64 ;; esac' } });
    expect(r.exitCode).toBe(0);
    const line = r.commands.find((c) => c.startsWith('mkdir -p'));
    expect(line).toBeDefined();
    // La ligne affichée doit se réévaluer en le chemin d'origine.
    const back = await execa('/bin/sh', ['-c', `set -- ${line!.replace(/^mkdir -p /, '')}; printf '%s' "$1"`], { reject: false });
    expect(back.stdout).toBe(join(home, '.local/bin'));
  });

  it.skipIf(!DASH)('exécution complète sous dash : mêmes commandes que sous sh', async () => {
    const home = await tempDir('sisyphe-inst-home-');
    const fakes: Fakes = { uname: 'case "$1" in -m) echo x86_64 ;; esac' };
    const sh = await runInstall({ os: 'ubuntu', home, fakes });
    const withDash = await runInstall({ os: 'ubuntu', home, fakes, shell: DASH });
    expect(withDash.exitCode).toBe(0);
    expect(withDash.commands).toEqual(sh.commands);
  });

  it('--dry-run n exécute que des sondes en lecture seule', async () => {
    const log = join(await tempDir('sisyphe-inst-log-'), 'exec.log');
    const r = await runInstall({ os: 'darwin', fakes: tracingFakes(log) });
    expect(r.exitCode).toBe(0);
    // Rien d'autre que la lecture d'un état : ni pull, ni npm, ni setup, ni
    // `claude auth status` (qui ne doit pas être interrogé en --dry-run).
    expect(await readLog(log)).toEqual([
      'node|1|-v',
      'npm|2|prefix -g',
      'git|2|rev-parse --is-inside-work-tree',
      'git|1|remote',
      'git|2|status --porcelain',
    ]);
  });

  it('hors --dry-run : les commandes sont exécutées avec leurs arguments séparés', async () => {
    const dir = await tempDir('sisyphe-inst-clone-');
    const script = join(dir, 'install.sh');
    await copyFile(SCRIPT, script);
    await chmod(script, 0o755);
    const log = join(await tempDir('sisyphe-inst-log-'), 'exec.log');
    const r = await runInstall({ os: 'darwin', fakes: tracingFakes(log), script, dryRun: false });
    expect(r.exitCode).toBe(0);
    // `npm|2|run build` prouve que les arguments sont passés séparément :
    // un `run "npm run build"` donnerait un seul argument.
    expect(await readLog(log)).toEqual([
      'node|1|-v',
      'npm|2|prefix -g',
      'git|2|rev-parse --is-inside-work-tree',
      'git|1|remote',
      'git|2|status --porcelain',
      'git|2|pull --ff-only',
      'npm|1|ci',
      'npm|2|run build',
      'npm|1|link',
      'sisyphe|1|setup',
      'claude|3|auth status --json',
    ]);
  });

  it('branche sans suivi distant : le pull échoue, le build continue', async () => {
    const dir = await tempDir('sisyphe-inst-repo-');
    const git = (...args: string[]) =>
      execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', dir, ...args], { reject: false });
    await git('init', '-b', 'main');
    await writeFile(join(dir, 'README.md'), '# tmp\n');
    await copyFile(SCRIPT, join(dir, 'install.sh'));
    await chmod(join(dir, 'install.sh'), 0o755);
    await git('add', '-A');
    await git('commit', '-m', 'tmp');
    // Un distant déclaré mais injoignable, et aucune branche de suivi : le
    // `git pull --ff-only` échoue sans réseau, de façon déterministe.
    await git('remote', 'add', 'origin', join(dir, 'distant-absent.git'));

    const log = join(await tempDir('sisyphe-inst-log-'), 'exec.log');
    const fakes = tracingFakes(log);
    delete fakes.git; // le vrai git, pour un vrai échec de pull
    const r = await runInstall({
      os: 'darwin',
      fakes,
      realTools: ['git'],
      script: join(dir, 'install.sh'),
      dryRun: false,
      args: ['--no-setup'],
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mise à jour impossible');
    // Le build a bien eu lieu malgré l'échec du pull.
    expect(await readLog(log)).toEqual(['node|1|-v', 'npm|2|prefix -g', 'npm|1|ci', 'npm|2|run build', 'npm|1|link', 'claude|3|auth status --json']);
  });
});
