import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../config/paths.js';
import type { Exec, ExecResult } from './exec.js';
import { SYSTEMD_UNIT, SystemdServiceManager, parseSystemctlShow, renderUnit, unitPath } from './systemd.js';
import type { ServiceContext } from './types.js';

describe('renderUnit', () => {
  const input = { nodePath: '/usr/bin/node', scriptPath: '/x/dist/cli/index.js', paths: dataPaths('/home/v/.sisyphe') };

  it('produit l’unité complète : sections dans l’ordre, ExecStart start, Restart=on-failure, une ligne Environment par variable', () => {
    const unit = renderUnit({ ...input, env: { PATH: '/usr/bin:/bin', HOME: '/home/v', SISYPHE_HOME: '/home/v/.sisyphe' } });
    expect(unit).toBe(
      [
        '[Unit]',
        'Description=Sisyphe daemon',
        '',
        '[Service]',
        'ExecStart=/usr/bin/node /x/dist/cli/index.js start',
        'WorkingDirectory=/home/v/.sisyphe',
        'Environment=PATH=/usr/bin:/bin',
        'Environment=HOME=/home/v',
        'Environment=SISYPHE_HOME=/home/v/.sisyphe',
        'Restart=on-failure',
        'RestartSec=30',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  it('sans SISYPHE_HOME ni clé : seules les variables de env sont écrites', () => {
    const unit = renderUnit({ ...input, env: { PATH: '/usr/bin', HOME: '/home/v' } });
    expect(unit).not.toContain('SISYPHE_HOME');
    expect(unit).not.toContain('ANTHROPIC_API_KEY');
    expect(unit.match(/^Environment=/gm)).toHaveLength(2);
  });

  it('cite entre guillemets les valeurs avec espace ou quote, et double les % (spécificateurs systemd)', () => {
    const unit = renderUnit({
      nodePath: '/Users/v/My Tools/node', scriptPath: '/x/dist/cli/index.js', paths: dataPaths('/home/v/data dir'),
      env: { PATH: '/opt/a b/bin:/usr/bin', HOME: '/home/v', ANTHROPIC_API_KEY: "sk-100%'x" },
    });
    expect(unit).toContain('ExecStart="/Users/v/My Tools/node" /x/dist/cli/index.js start');
    expect(unit).toContain('Environment="PATH=/opt/a b/bin:/usr/bin"');
    expect(unit).toContain(`Environment="ANTHROPIC_API_KEY=sk-100%%'x"`); // une quote simple non citée ouvrirait une citation
  });

  it('WorkingDirectory n’est jamais cité : systemd ne déquote pas cette directive et rejetterait l’unité', () => {
    const unit = renderUnit({ ...input, paths: dataPaths('/home/v/data dir'), env: {} });
    expect(unit).toContain('WorkingDirectory=/home/v/data dir');
    expect(unit).not.toContain('WorkingDirectory="');
  });

  it('ExecStart : $ littéral doublé (ligne de commande), mais laissé tel quel dans Environment (aucune expansion)', () => {
    const unit = renderUnit({
      nodePath: '/opt/node$v/bin/node', scriptPath: '/x/dist/cli/index.js', paths: dataPaths('/home/v/.sisyphe'),
      env: { ANTHROPIC_API_KEY: 'sk-$v' },
    });
    expect(unit).toContain('ExecStart=/opt/node$$v/bin/node /x/dist/cli/index.js start');
    expect(unit).toContain('Environment=ANTHROPIC_API_KEY=sk-$v');
  });
});

const show = (kv: Record<string, string>) => `${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

describe('parseSystemctlShow', () => {
  it('lit les quatre propriétés d’une unité active', () => {
    expect(parseSystemctlShow(show({ ActiveState: 'active', SubState: 'running', MainPID: '4242', UnitFileState: 'enabled' }))).toEqual({
      activeState: 'active', subState: 'running', mainPid: 4242, unitFileState: 'enabled',
    });
  });

  it('unité inconnue : UnitFileState vide ou absent → chaîne vide, MainPID 0', () => {
    expect(parseSystemctlShow(show({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0', UnitFileState: '' }))).toEqual({
      activeState: 'inactive', subState: 'dead', mainPid: 0, unitFileState: '',
    });
    expect(parseSystemctlShow(show({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0' }))).toEqual({
      activeState: 'inactive', subState: 'dead', mainPid: 0, unitFileState: '',
    });
  });

  it('sortie vide : valeurs par défaut, jamais NaN', () => {
    expect(parseSystemctlShow('')).toEqual({ activeState: '', subState: '', mainPid: 0, unitFileState: '' });
  });
});

describe('SystemdServiceManager', () => {
  let root: string;
  let home: string;
  let calls: string[][];
  /** Réponses scriptées par verbe (`daemon-reload`, `enable`, `show`, `enable-linger`…) ; absente → succès muet. */
  let replies: Record<string, ExecResult[]>;

  const ok: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
  const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: '', stderr });
  const shown = (kv: Record<string, string>): ExecResult => ({ exitCode: 0, stdout: show(kv), stderr: '' });

  // systemctl : `--user <verbe> …` ; loginctl : `<verbe>`.
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const verb = file === 'systemctl' ? args[1]! : args[0]!;
    return replies[verb]?.shift() ?? ok;
  };

  function manager(): SystemdServiceManager {
    const ctx: ServiceContext = {
      paths: dataPaths(join(root, 'data')), nodePath: '/usr/bin/node', scriptPath: '/x/dist/cli/index.js',
      env: { PATH: '/usr/bin', HOME: home },
      client: { send: async () => ({ ok: true, result: null }), isReachable: async () => false },
      exec, homeDir: home, uid: 1000,
    };
    return new SystemdServiceManager(ctx);
  }

  const exists = (p: string) => stat(p).then(() => true, () => false);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-systemd-'));
    home = join(root, 'home', 'victor');
    await mkdir(join(root, 'data'));
    await mkdir(home, { recursive: true });
    calls = [];
    replies = {};
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('install : crée .config/systemd/user, écrit l’unité en 0600, daemon-reload puis enable-linger ; aucun démarrage', async () => {
    const unit = unitPath(home);
    expect(await manager().install()).toEqual({ warnings: [] });
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['loginctl', 'enable-linger'],
    ]);
    expect(unit).toBe(join(home, '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.service`));
    const content = await readFile(unit, 'utf8');
    expect(content).toContain('ExecStart=/usr/bin/node /x/dist/cli/index.js start');
    expect(content).toContain(`WorkingDirectory=${join(root, 'data')}`);
    expect(content).toContain(`Environment=HOME=${home}`);
    expect((await stat(unit)).mode & 0o777).toBe(0o600);
  });

  it('install : une unité préexistante en 0644 est réécrite et ramenée à 0600', async () => {
    const unit = unitPath(home);
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(unit, 'ancienne');
    await chmod(unit, 0o644);
    await manager().install();
    expect((await stat(unit)).mode & 0o777).toBe(0o600);
    expect(await readFile(unit, 'utf8')).toContain('[Service]');
  });

  it('install : loginctl enable-linger refusé → avertissement avec la commande sudo, installation poursuivie', async () => {
    replies = { 'enable-linger': [fail('Could not enable linger: Access denied')] };
    expect(await manager().install()).toEqual({
      warnings: [`\`sudo loginctl enable-linger ${userInfo().username}\` à lancer une fois, sinon le service s'arrête à la déconnexion`],
    });
    expect(await exists(unitPath(home))).toBe(true);
  });

  it('install : daemon-reload en échec → erreur qui cite la commande, son stderr et la reprise, sans appeler loginctl', async () => {
    replies = { 'daemon-reload': [fail('Failed to connect to bus: No medium found')] };
    await expect(manager().install()).rejects.toThrow(
      "systemctl --user daemon-reload a échoué (code 1) : Failed to connect to bus: No medium found. L'unité est écrite mais non chargée : relancer « sisyphe setup --reinstall-service » une fois le problème corrigé.",
    );
    expect(calls).toEqual([['systemctl', '--user', 'daemon-reload']]);
  });

  it('start : enable --now', async () => {
    await manager().start();
    expect(calls).toEqual([['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT]]);
  });

  it('start : échec → erreur avec la commande ; stdout repris quand stderr est vide', async () => {
    replies = { enable: [{ exitCode: 1, stdout: 'Unit sisyphe.service does not exist', stderr: '' }] };
    await expect(manager().start()).rejects.toThrow(
      'systemctl --user enable --now sisyphe a échoué (code 1) : Unit sisyphe.service does not exist',
    );
  });

  it('stop : disable --now (un stop explicite n’est pas relancé par Restart=on-failure)', async () => {
    await manager().stop();
    expect(calls).toEqual([['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]]);
  });

  it('stop : échec → erreur avec la commande et le stderr', async () => {
    replies = { disable: [fail('Failed to stop sisyphe.service: Access denied')] };
    await expect(manager().stop()).rejects.toThrow('systemctl --user disable --now sisyphe a échoué (code 1) : Failed to stop sisyphe.service: Access denied');
  });

  it('status : interroge show avec les quatre propriétés ; unité inconnue (UnitFileState vide) → non installée', async () => {
    replies = { show: [shown({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0' })] };
    expect(await manager().status()).toEqual({
      kind: 'systemd', installed: false, running: false, pid: null, enabledAtBoot: false, detail: 'unité systemd non installée',
    });
    expect(calls).toEqual([['systemctl', '--user', 'show', SYSTEMD_UNIT, '-p', 'ActiveState,SubState,MainPID,UnitFileState']]);
  });

  it('status : UnitFileState=not-found → non installée', async () => {
    replies = { show: [shown({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0', UnitFileState: 'not-found' })] };
    expect(await manager().status()).toMatchObject({ installed: false, running: false, pid: null, enabledAtBoot: false });
  });

  it('status : installée, inactive, désactivée au boot', async () => {
    replies = { show: [shown({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0', UnitFileState: 'disabled' })] };
    expect(await manager().status()).toEqual({
      kind: 'systemd', installed: true, running: false, pid: null, enabledAtBoot: false, detail: 'inactive (dead)',
    });
  });

  it('status : active avec pid, activée au boot', async () => {
    replies = { show: [shown({ ActiveState: 'active', SubState: 'running', MainPID: '4242', UnitFileState: 'enabled' })] };
    expect(await manager().status()).toEqual({
      kind: 'systemd', installed: true, running: true, pid: 4242, enabledAtBoot: true, detail: 'active (running)',
    });
  });

  it('status : systemctl introuvable (exit 127) → non installée, avec un détail qui le dit', async () => {
    replies = { show: [{ exitCode: 127, stdout: '', stderr: 'spawn systemctl ENOENT' }] };
    expect(await manager().status()).toEqual({
      kind: 'systemd', installed: false, running: false, pid: null, enabledAtBoot: false, detail: 'systemctl introuvable',
    });
  });

  it('status : autre échec de show → non installée, le détail reprend la commande et le stderr sans lever', async () => {
    replies = { show: [fail('Failed to connect to bus: No medium found')] };
    expect(await manager().status()).toEqual({
      kind: 'systemd', installed: false, running: false, pid: null, enabledAtBoot: false,
      detail: 'systemctl --user show sisyphe -p ActiveState,SubState,MainPID,UnitFileState a échoué (code 1) : Failed to connect to bus: No medium found',
    });
  });

  it('uninstall : disable --now, suppression de l’unité, daemon-reload', async () => {
    const m = manager();
    await m.install();
    calls = [];
    await m.uninstall();
    expect(calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(await exists(unitPath(home))).toBe(false);
  });

  it('uninstall : idempotent quand rien n’est installé (disable en échec ignoré, daemon-reload quand même)', async () => {
    replies = { disable: [fail('Unit file sisyphe.service does not exist.')] };
    await expect(manager().uninstall()).resolves.toBeUndefined();
    expect(calls.map((c) => c[2])).toEqual(['disable', 'daemon-reload']);
  });

  it('uninstall : daemon-reload en échec → erreur brute, sans le conseil de réinstallation propre à install', async () => {
    replies = { 'daemon-reload': [fail('Failed to connect to bus: No medium found')] };
    await expect(manager().uninstall()).rejects.toThrow(
      new Error('systemctl --user daemon-reload a échoué (code 1) : Failed to connect to bus: No medium found'),
    );
  });
});
