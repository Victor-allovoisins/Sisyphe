import { describe, expect, it } from 'vitest';
import { isLargeDiff, matchProtectedPaths } from './flags.js';

describe('flags', () => {
  it('matche les globs de chemins protégés, y compris dotfiles', () => {
    const files = ['App/Config.xcconfig', 'fastlane/Fastfile', '.github/workflows/ci.yml', 'Sources/A.swift'];
    expect(matchProtectedPaths(files, ['**/*.xcconfig', 'fastlane/**', '.github/**'])).toEqual(['App/Config.xcconfig', 'fastlane/Fastfile', '.github/workflows/ci.yml']);
    expect(matchProtectedPaths(files, [])).toEqual(['.github/workflows/ci.yml']);
    expect(matchProtectedPaths(['App/Config.XCCONFIG'], ['**/*.xcconfig'])).toEqual(['App/Config.XCCONFIG']);
    expect(matchProtectedPaths(['.claude/settings.json', '.mcp.json', 'sisyphe.yml', 'src/a.ts'], [])).toEqual(['.claude/settings.json', '.mcp.json', 'sisyphe.yml']);
    expect(matchProtectedPaths(['packages/x/.claude/settings.json', 'packages/x/src/a.ts'], [])).toEqual(['packages/x/.claude/settings.json']);
  });
  it('détecte un gros diff strictement au-dessus du seuil', () => {
    expect(isLargeDiff(800, 800)).toBe(false);
    expect(isLargeDiff(801, 800)).toBe(true);
  });
});
