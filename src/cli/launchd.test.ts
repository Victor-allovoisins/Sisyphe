import { describe, expect, it } from 'vitest';
import { parseLaunchctlPrint, renderPlist } from './launchd.js';

describe('renderPlist', () => {
  it('produit un plist launchd complet et échappé', () => {
    const p = renderPlist({
      label: 'com.sisyphe.daemon', nodePath: '/opt/homebrew/bin/node', scriptPath: '/x/dist/cli/index.js',
      dataDir: '/Users/v/.sisyphe', logsDir: '/Users/v/.sisyphe/logs', env: { ANTHROPIC_API_KEY: 'sk-<a&b>', PATH: '/bin' },
    });
    expect(p).toContain('<key>Label</key><string>com.sisyphe.daemon</string>');
    expect(p).toContain('<string>/x/dist/cli/index.js</string>');
    expect(p).toContain('<string>start</string>');
    expect(p).toContain('<key>ANTHROPIC_API_KEY</key>');
    expect(p).toContain('<string>sk-&lt;a&amp;b&gt;</string>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('/Users/v/.sisyphe/logs/launchd.err.log');
  });

  it('préfixe le PATH avec le répertoire du node exécutant et redirige stdout vers /dev/null', () => {
    const p = renderPlist({
      label: 'com.sisyphe.daemon', nodePath: '/opt/homebrew/bin/node', scriptPath: '/x/dist/cli/index.js',
      dataDir: '/Users/v/.sisyphe', logsDir: '/Users/v/.sisyphe/logs', env: { PATH: '/usr/bin:/opt/homebrew/bin:/bin' },
    });
    expect(p).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>'); // sans doublon du répertoire du node
    expect(p).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
  });
});

describe('parseLaunchctlPrint', () => {
  const print = (lines: string[]) => ['com.sisyphe.daemon = {', ...lines.map((l) => `\t${l}`), '}'].join('\n');

  it('lit state et last exit code', () => {
    expect(parseLaunchctlPrint(print(['state = running', 'pid = 421', 'last exit code = 0']))).toEqual({ state: 'running', lastExitCode: 0 });
  });

  it("rend null quand le code de sortie est absent : jamais un 0 inventé", () => {
    expect(parseLaunchctlPrint(print(['state = running', 'pid = 421']))).toEqual({ state: 'running', lastExitCode: null });
  });

  it('lit un code de sortie négatif (tué par un signal) et un state inconnu', () => {
    expect(parseLaunchctlPrint(print(['last exit code = -9']))).toEqual({ state: '?', lastExitCode: -9 });
  });
});
