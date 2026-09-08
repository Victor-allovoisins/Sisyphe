import picomatch from 'picomatch';

export function matchProtectedPaths(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const isMatch = picomatch(patterns, { dot: true, nocase: true });
  return files.filter((f) => isMatch(f));
}

export function isLargeDiff(changedLines: number, maxDiffLines: number): boolean {
  return changedLines > maxDiffLines;
}
