import { describe, expect, it } from 'vitest';
import { allStatusLabelNames, labelDefinitions, statusFromLabel, statusLabelName } from './labels.js';
import { issueRefOf, parseRepo } from './source.js';

describe('labels', () => {
  it('dérive les noms de statut du label trigger', () => {
    expect(statusLabelName('sisyphe', 'blocked')).toBe('sisyphe:blocked');
    expect(allStatusLabelNames('bot')).toEqual(['bot:in-progress', 'bot:blocked', 'bot:done', 'bot:failed']);
    expect(statusFromLabel('sisyphe', 'sisyphe:done')).toBe('done');
    expect(statusFromLabel('sisyphe', 'bug')).toBeNull();
    expect(labelDefinitions('sisyphe').map((l) => l.name)).toContain('sisyphe');
  });
});

describe('parseRepo', () => {
  it('découpe owner/name', () => {
    expect(parseRepo('ILokYou/ILokYou-iOS')).toEqual({ owner: 'ILokYou', name: 'ILokYou-iOS', full: 'ILokYou/ILokYou-iOS' });
    expect(() => parseRepo('nope')).toThrow();
    expect(issueRefOf({ repo: 'a/b', issueNumber: 3 })).toEqual({ repo: { owner: 'a', name: 'b', full: 'a/b' }, number: 3 });
  });
});
