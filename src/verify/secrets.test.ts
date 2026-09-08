import { execa } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAK_EXIT_CODE, SecretScanError, fileAtPatchLine, isAddedLine, parseGitleaksReport, scanPatch } from './secrets.js';

// Clé factice retenue parce que gitleaks 8.30 la détecte (entropie 4.02) ; d'autres clés AKIA… au format valide passent sous son seuil.
const KEY = 'AKIAZ7Q2X4L6M3N5P2R7';
const patchAdded = `diff --git a/Config.swift b/Config.swift
--- a/Config.swift
+++ b/Config.swift
@@ -0,0 +1 @@
+let aws = "${KEY}"
diff --git a/Other.swift b/Other.swift
+++ b/Other.swift
@@ -0,0 +1 @@
+let x = 1
`;
const patchContext = `diff --git a/Config.swift b/Config.swift
--- a/Config.swift
+++ b/Config.swift
@@ -1,3 +1,3 @@
 let existing = "${KEY}"
-let old = 1
+let renamed = 1
`;

const hasGitleaks = (await execa('gitleaks', ['version'], { reject: false })).exitCode === 0;

describe('parseGitleaksReport', () => {
  it('extrait fichier, règle et ligne, et refuse un rapport qui n’est pas un tableau', () => {
    expect(parseGitleaksReport(JSON.stringify([{ RuleID: 'aws-access-token', StartLine: 5, File: 'diff.patch' }]))).toEqual([{ file: 'diff.patch', ruleId: 'aws-access-token', line: 5 }]);
    expect(parseGitleaksReport('')).toEqual([]);
    expect(() => parseGitleaksReport('null')).toThrow(SecretScanError);
  });
});

describe('fileAtPatchLine / isAddedLine', () => {
  it('retrouve le fichier réel et distingue les lignes ajoutées', () => {
    expect(fileAtPatchLine(patchAdded, 5)).toBe('Config.swift');
    expect(fileAtPatchLine(patchAdded, 9)).toBe('Other.swift');
    expect(fileAtPatchLine(patchAdded, 1)).toBeNull();
    expect(fileAtPatchLine('+++ "b/pa th.swift"\n+x\n', 2)).toBe('pa th.swift');
    expect(fileAtPatchLine('+++ b/a\n+++ /dev/null\n-x\n', 3)).toBeNull();
    expect(isAddedLine(patchAdded, 5)).toBe(true);
    expect(isAddedLine(patchAdded, 3)).toBe(false); // en-tête +++
    expect(isAddedLine(patchContext, 5)).toBe(false); // contexte
    expect(isAddedLine(patchContext, 6)).toBe(false); // suppression
  });
});

describe('scanPatch', () => {
  it('renvoie vide sur code 0, filtre sur les lignes ajoutées, lève sinon avec le détail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-scan-'));
    const patchFile = join(dir, 'diff.patch');
    const report = join(dir, 'r.json');
    await writeFile(patchFile, patchAdded);
    await writeFile(report, JSON.stringify([{ RuleID: 'aws-access-token', StartLine: 5, File: 'diff.patch' }, { RuleID: 'x', StartLine: 3, File: 'diff.patch' }]));
    expect(await scanPatch(patchFile, report, { timeoutMs: 10_000 }, async () => ({ exitCode: 0, output: '' }))).toEqual([]);
    expect(await scanPatch(patchFile, report, { timeoutMs: 10_000 }, async () => ({ exitCode: LEAK_EXIT_CODE, output: '' }))).toEqual([{ file: 'Config.swift', ruleId: 'aws-access-token', line: 5 }]);
    await expect(scanPatch(patchFile, report, { timeoutMs: 10_000 }, async () => ({ exitCode: -1, output: 'Command failed with ENOENT: gitleaks dir' }))).rejects.toThrow(/ENOENT/);
    await expect(scanPatch(patchFile, join(dir, 'absent.json'), { timeoutMs: 10_000 }, async () => ({ exitCode: LEAK_EXIT_CODE, output: '' }))).rejects.toThrow(SecretScanError);
  });

  it.skipIf(!hasGitleaks)('avec le vrai gitleaks : détecte une clé ajoutée, ignore une clé préexistante en contexte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-scan-'));
    const added = join(dir, 'added.patch');
    const context = join(dir, 'context.patch');
    await writeFile(added, patchAdded);
    await writeFile(context, patchContext);
    const found = await scanPatch(added, join(dir, 'a.json'), { timeoutMs: 10_000 });
    expect(found.map((f) => [f.file, f.ruleId])).toEqual([['Config.swift', 'aws-access-token']]);
    expect(await scanPatch(context, join(dir, 'c.json'), { timeoutMs: 10_000 })).toEqual([]);
  });
});
