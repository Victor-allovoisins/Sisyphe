import picomatch from 'picomatch';

/** Toujours protégés, quelle que soit la config : settings/hook du CLI (exécutés avec les privilèges du daemon), config MCP, config Sisyphe, workflows CI. */
export const BASELINE_PROTECTED_GLOBS = [
  '.claude/**', '**/.claude/**',
  '.mcp.json', '**/.mcp.json',
  'sisyphe.yml',
  '.github/workflows/**', '**/.github/workflows/**',
];

export function matchProtectedPaths(files: string[], patterns: string[]): string[] {
  const isMatch = picomatch([...BASELINE_PROTECTED_GLOBS, ...patterns], { dot: true, nocase: true });
  return files.filter((f) => isMatch(f));
}

export function isLargeDiff(changedLines: number, maxDiffLines: number): boolean {
  return changedLines > maxDiffLines;
}
