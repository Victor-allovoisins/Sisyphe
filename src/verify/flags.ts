import picomatch from 'picomatch';

export function matchProtectedPaths(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const isMatch = picomatch(patterns, { dot: true });
  return files.filter((f) => isMatch(f));
}

export function isLargeDiff(changedLines: number, maxDiffLines: number): boolean {
  return changedLines > maxDiffLines;
}

export function tail(text: string, lines = 200): string {
  const arr = text.split('\n');
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}
