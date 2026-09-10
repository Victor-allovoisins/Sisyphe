import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../config/paths.js';
import type { Exec, ExecResult } from './exec.js';
import { LAUNCHD_LABEL, LaunchdServiceManager, enabledPath, parseLaunchctlPrint, plistPath, renderPlist } from './launchd.js';
import type { ServiceContext } from './types.js';

describe('renderPlist', () => {
  const input = {
    label: 'com.sisyphe.daemon', nodePath: '/opt/homebrew/bin/node', scriptPath: '/x/dist/cli/index.js',
    dataDir: '/Users/v/.sisyphe', logsDir: '/Users/v/.sisyphe/logs',
  };

  it('produit un plist launchd complet et échappé', () => {
    const p = renderPlist({ ...input, env: { ANTHROPIC_API_KEY: 'sk-<a&b>', PATH: '/bin' } });
    expect(p).toContain('<key>Label</key><string>com.sisyphe.daemon</string>');
    expect(p).toContain('<key>ANTHROPIC_API_KEY</key>');
    expect(p).toContain('<string>sk-&lt;a&amp;b&gt;</string>');
    expect(p).toContain('/Users/v/.sisyphe/logs/launchd.err.log');
    expect(p).toContain('<key>ThrottleInterval</key><integer>30</integer>');
  });

  it('ProgramArguments : node, le script buildé, start', () => {
    const p = renderPlist({ ...input, env: {} });
    expect(p).toContain(
      '<key>ProgramArguments</key>\n  <array>\n    <string>/opt/homebrew/bin/node</string>\n    <string>/x/dist/cli/index.js</string>\n    <string>start</string>\n  </array>',
    );
  });

  it('ne démarre rien au chargement : RunAtLoad false, KeepAlive piloté par le fichier enabled', () => {
    const p = renderPlist({ ...input, env: {} });
    expect(p).toContain('<key>RunAtLoad</key><false/>');
    expect(p).toContain(
      '<key>KeepAlive</key>\n  <dict>\n    <key>PathState</key>\n    <dict>\n      <key>/Users/v/.sisyphe/enabled</key><true/>\n    </dict>\n  </dict>',
    );
    expect(p).not.toContain('<key>KeepAlive</key><true/>');
  });

  it('préfixe le PATH avec le répertoire du node exécutant et redirige stdout vers /dev/null', () => {
    const p = renderPlist({ ...input, env: { PATH: '/usr/bin:/opt/homebrew/bin:/bin' } });
    expect(p).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>'); // sans doublon du répertoire du node
    expect(p).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
  });
});

const print = (lines: string[]) => ['com.sisyphe.daemon = {', ...lines.map((l) => `\t${l}`), '}'].join('\n');

describe('parseLaunchctlPrint', () => {
  it('lit state, pid et last exit code', () => {
    expect(parseLaunchctlPrint(print(['state = running', 'pid = 421', 'last exit code = 0']))).toEqual({ state: 'running', lastExitCode: 0, pid: 421 });
  });

  it('rend null quand le code de sortie est absent : jamais un 0 inventé', () => {
    expect(parseLaunchctlPrint(print(['state = running', 'pid = 421']))).toEqual({ state: 'running', lastExitCode: null, pid: 421 });
  });

  it('rend pid null quand le job ne tourne pas, et lit un code négatif (tué par un signal) et un state inconnu', () => {
    expect(parseLaunchctlPrint(print(['last exit code = -9']))).toEqual({ state: '?', lastExitCode: -9, pid: null });
  });
});

describe('LaunchdServiceManager', () => {
  let root: string;
  let calls: string[][];
  /** Réponses scriptées par sous-commande launchctl ; absente → succès muet. */
  let replies: Record<string, ExecResult[]>;
  let sent: string[];
  let reachable: boolean;
  /** `send('stop')` rejette : daemon qui répond au ping mais reste coincé derrière sa porte. */
  let sendRejects: boolean;
  let slept: number[];

  const ok: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
  const fail = (stderr: string): ExecResult => ({ exitCode: 5, stdout: '', stderr });

  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return replies[args[0]!]?.shift() ?? ok;
  };

  function manager(): LaunchdServiceManager {
    const paths = dataPaths(join(root, 'data'));
    const ctx: ServiceContext = {
      paths, nodePath: '/opt/homebrew/bin/node', scriptPath: '/x/dist/cli/index.js', env: { PATH: '/bin', HOME: root },
      client: {
        send: async (cmd) => {
          sent.push(cmd);
          if (sendRejects) throw new Error('le daemon ne répond pas (30000 ms)');
          return { ok: true, result: null };
        },
        isReachable: async () => reachable,
      },
      exec, homeDir: join(root, 'home'), uid: 501,
    };
    return new LaunchdServiceManager(ctx, { sleep: async (ms) => { slept.push(ms); } });
  }

  const exists = (p: string) => stat(p).then(() => true, () => false);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-launchd-'));
    await mkdir(join(root, 'data'));
    calls = [];
    replies = {};
    sent = [];
    reachable = true;
    sendRejects = false;
    slept = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('install : écrit le plist en 0600 sous homeDir, bootout puis bootstrap, sans créer enabled', async () => {
    const m = manager();
    const plist = plistPath(join(root, 'home'));
    expect(await m.install()).toEqual({ warnings: [] });
    expect(calls).toEqual([
      ['launchctl', 'bootout', 'gui/501', plist],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ]);
    const content = await readFile(plist, 'utf8');
    expect(content).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(content).toContain(`<key>${enabledPath(join(root, 'data'))}</key><true/>`);
    expect((await stat(plist)).mode & 0o777).toBe(0o600);
    expect(await exists(enabledPath(join(root, 'data')))).toBe(false);
    expect(slept).toEqual([]);
  });

  it('install : un plist préexistant en 0644 (ancien setup) est ramené à 0600', async () => {
    const plist = plistPath(join(root, 'home'));
    await mkdir(join(root, 'home', 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plist, 'ancien');
    await chmod(plist, 0o644);
    await manager().install();
    expect((await stat(plist)).mode & 0o777).toBe(0o600);
    expect(await readFile(plist, 'utf8')).toContain('<key>ProgramArguments</key>');
  });

  it('install : un bootstrap qui échoue est retenté une fois après 500 ms', async () => {
    replies = { bootstrap: [fail('Input/output error'), ok] };
    await manager().install();
    expect(calls.map((c) => c[1])).toEqual(['bootout', 'bootstrap', 'bootstrap']);
    expect(slept).toEqual([500]);
  });

  it('install : deux bootstrap en échec → erreur avec la sortie launchctl et le bootout à essayer', async () => {
    replies = { bootstrap: [fail('Bootstrap failed: 5: Input/output error'), fail('Bootstrap failed: 5: Input/output error')] };
    await expect(manager().install()).rejects.toThrow(
      `Impossible de charger l'agent launchd : Bootstrap failed: 5: Input/output error. Essayer « launchctl bootout gui/$UID/${LAUNCHD_LABEL} » puis relancer sisyphe setup.`,
    );
  });

  it('start : crée enabled (0600) puis kickstart', async () => {
    await manager().start();
    const enabled = enabledPath(join(root, 'data'));
    expect((await stat(enabled)).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([['launchctl', 'kickstart', `gui/501/${LAUNCHD_LABEL}`]]);
  });

  it('start : un enabled préexistant trop ouvert est ramené à 0600', async () => {
    const enabled = enabledPath(join(root, 'data'));
    await writeFile(enabled, '');
    await chmod(enabled, 0o644);
    await manager().start();
    expect((await stat(enabled)).mode & 0o777).toBe(0o600);
  });

  it('start : un kickstart en échec remonte la sortie launchctl et retire enabled (un install() ultérieur ne doit pas démarrer)', async () => {
    replies = { kickstart: [fail('Could not find service')] };
    await expect(manager().start()).rejects.toThrow("Impossible de démarrer l'agent launchd : Could not find service");
    expect(await exists(enabledPath(join(root, 'data')))).toBe(false);
  });

  it('stop : supprime enabled puis envoie stop sur la socket ; aucun launchctl quand le daemon répond', async () => {
    const enabled = enabledPath(join(root, 'data'));
    await writeFile(enabled, '');
    await manager().stop();
    expect(await exists(enabled)).toBe(false);
    expect(sent).toEqual(['stop']);
    expect(calls).toEqual([]);
  });

  it('stop : send rejeté (daemon coincé derrière sa porte) → kill SIGTERM via launchd', async () => {
    sendRejects = true;
    await manager().stop();
    expect(sent).toEqual(['stop']);
    expect(calls).toEqual([['launchctl', 'kill', 'SIGTERM', `gui/501/${LAUNCHD_LABEL}`]]);
  });

  it('stop : socket injoignable → kill SIGTERM via launchd, sans envoyer stop', async () => {
    reachable = false;
    await manager().stop();
    expect(sent).toEqual([]);
    expect(calls).toEqual([['launchctl', 'kill', 'SIGTERM', `gui/501/${LAUNCHD_LABEL}`]]);
  });

  it('status : launchctl print en échec → non installé, enabledAtBoot reflète le fichier', async () => {
    replies = { print: [fail('Could not find service')] };
    await writeFile(enabledPath(join(root, 'data')), '');
    expect(await manager().status()).toEqual({
      kind: 'launchd', installed: false, running: false, pid: null, enabledAtBoot: true, detail: 'agent launchd non chargé',
    });
    expect(calls).toEqual([['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`]]);
  });

  it('status : launchctl introuvable (exit 127) → non installé, avec un détail qui le dit', async () => {
    replies = { print: [{ exitCode: 127, stdout: '', stderr: 'spawn launchctl ENOENT' }] };
    expect(await manager().status()).toMatchObject({ kind: 'launchd', installed: false, running: false, pid: null, detail: 'launchctl introuvable' });
  });

  it('status : job running avec pid', async () => {
    replies = { print: [{ exitCode: 0, stdout: print(['state = running', 'pid = 4242']), stderr: '' }] };
    await writeFile(enabledPath(join(root, 'data')), '');
    expect(await manager().status()).toEqual({
      kind: 'launchd', installed: true, running: true, pid: 4242, enabledAtBoot: true, detail: 'state = running',
    });
  });

  it('status : chargé mais arrêté, sans enabled', async () => {
    replies = { print: [{ exitCode: 0, stdout: print(['state = not running', 'last exit code = 0']), stderr: '' }] };
    expect(await manager().status()).toEqual({
      kind: 'launchd', installed: true, running: false, pid: null, enabledAtBoot: false, detail: 'state = not running, last exit code = 0',
    });
  });

  it('uninstall : bootout par cible de service, puis suppression du plist et de enabled', async () => {
    const plist = plistPath(join(root, 'home'));
    const enabled = enabledPath(join(root, 'data'));
    const m = manager();
    await m.install();
    await m.start();
    calls = [];
    await m.uninstall();
    expect(calls).toEqual([['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]]);
    expect(await exists(plist)).toBe(false);
    expect(await exists(enabled)).toBe(false);
  });

  it('uninstall : idempotent quand rien n’est installé', async () => {
    replies = { bootout: [fail('Could not find service')] };
    await expect(manager().uninstall()).resolves.toBeUndefined();
  });
});
