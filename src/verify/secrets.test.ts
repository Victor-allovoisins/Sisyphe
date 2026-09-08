import { execa } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAK_EXIT_CODE, SecretScanError, fileAtPatchLine, parseGitleaksReport, scanPatch } from './secrets.js';

const patch = `diff --git a/Config.swift b/Config.swift
--- a/Config.swift
+++ b/Config.swift
@@ -0,0 +1 @@
+let aws = "AKIAZ7Q2X4L6M3N5P2R7"
diff --git a/Other.swift b/Other.swift
+++ b/Other.swift
@@ -0,0 +1 @@
+let x = 1
`;

describe('parseGitleaksReport', () => {
  it('extrait fichier, règle et ligne', () => {
    const json = JSON.stringify([{ RuleID: 'aws-access-token', StartLine: 5, File: 'diff.patch', Secret: 'x' }]);
    expect(parseGitleaksReport(json)).toEqual([{ file: 'diff.patch', ruleId: 'aws-access-token', line: 5 }]);
    expect(parseGitleaksReport('')).toEqual([]);
  });
});

describe('fileAtPatchLine', () => {
  it('retrouve le fichier réel à partir de la ligne du patch', () => {
    expect(fileAtPatchLine(patch, 5)).toBe('Config.swift');
    expect(fileAtPatchLine(patch, 9)).toBe('Other.swift');
    expect(fileAtPatchLine(patch, 1)).toBeNull();
  });
});

const hasGitleaks = (await execa('gitleaks', ['version'], { reject: false })).exitCode === 0;

describe('scanPatch', () => {
  it('renvoie vide sur code 0, les findings sur LEAK_EXIT_CODE, lève sinon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-scan-'));
    const report = join(dir, 'r.json');
    await writeFile(report, JSON.stringify([{ RuleID: 'r', StartLine: 5, File: 'p' }]));
    expect(await scanPatch('p', report, async () => ({ exitCode: 0, output: '' }))).toEqual([]);
    expect(await scanPatch('p', report, async () => ({ exitCode: LEAK_EXIT_CODE, output: '' }))).toHaveLength(1);
    await expect(scanPatch('p', report, async () => ({ exitCode: 1, output: 'boom' }))).rejects.toThrow(SecretScanError);
  });

  it.skipIf(!hasGitleaks)('détecte une clé AWS avec le vrai gitleaks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-scan-'));
    const patchFile = join(dir, 'diff.patch');
    await writeFile(patchFile, patch);
    const findings = await scanPatch(patchFile, join(dir, 'r.json'));
    expect(findings.map((f) => f.ruleId)).toContain('aws-access-token');
  });
});
