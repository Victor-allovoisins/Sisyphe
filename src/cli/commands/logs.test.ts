import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderJobLogs } from './logs.js';

function captureConsoleLog(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  return logs;
}

describe('renderJobLogs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ne montre jamais Match ni Secret d'un gitleaks.json, même en mode résumé par défaut", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-logs-'));
    await writeFile(
      join(dir, 'gitleaks.json'),
      JSON.stringify([{ File: 'Config.swift', RuleID: 'generic-api-key', StartLine: 5, Match: 'sk-live-SUPERSECRET', Secret: 'sk-live-SUPERSECRET' }]),
    );
    const logs = captureConsoleLog();

    await renderJobLogs(dir, {});

    const output = logs.join('\n');
    expect(output).not.toContain('SUPERSECRET');
    expect(output).toContain('Config.swift');
    expect(output).toContain('generic-api-key');
    expect(output).toContain('ligne 5');
  });

  it('--raw affiche le fichier brut, y compris gitleaks.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-logs-'));
    await writeFile(join(dir, 'gitleaks.json'), JSON.stringify([{ File: 'a', RuleID: 'r', StartLine: 1, Secret: 'sk-live-SUPERSECRET' }]));
    const logs = captureConsoleLog();

    await renderJobLogs(dir, { raw: true });

    expect(logs.join('\n')).toContain('SUPERSECRET');
  });

  it('résume un transcript .jsonl et ne garde que les 40 dernières lignes d’un .log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-logs-'));
    const longLog = Array.from({ length: 100 }, (_, i) => `ligne ${i}`).join('\n');
    await writeFile(join(dir, 'verify-build.log'), longLog);
    await writeFile(join(dir, 'transcript-triage-1.jsonl'), JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.1, num_turns: 1 }));
    const logs = captureConsoleLog();

    await renderJobLogs(dir, {});

    const output = logs.join('\n');
    expect(output).not.toContain('ligne 10\n');
    expect(output).toContain('ligne 99');
    expect(output).toContain('✅ result success');
  });

  it('résume diff.patch en une ligne de stat plutôt que le patch entier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-logs-'));
    await writeFile(join(dir, 'diff.patch'), 'diff --git a/x b/x\n+++ b/x\n--- a/x\n+line1\n+line2\n-line3\n context\n');
    const logs = captureConsoleLog();

    await renderJobLogs(dir, {});

    expect(logs.join('\n')).toContain('+2/-1');
  });

  it('--phase filtre les fichiers dont le nom ne contient pas la sous-chaîne', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-logs-'));
    await writeFile(join(dir, 'setup.log'), 'setup ok');
    await writeFile(join(dir, 'verify-build.log'), 'verify ok');
    const logs = captureConsoleLog();

    await renderJobLogs(dir, { phase: 'setup' });

    const output = logs.join('\n');
    expect(output).toContain('setup.log');
    expect(output).not.toContain('verify-build.log');
  });
});
