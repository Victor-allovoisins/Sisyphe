import { describe, expect, it } from 'vitest';
import { hasWriteAccess, labelNames, lastLabeler } from './client.js';

describe('client helpers', () => {
  it('hasWriteAccess', () => {
    expect(hasWriteAccess('admin')).toBe(true);
    expect(hasWriteAccess('write')).toBe(true);
    expect(hasWriteAccess('maintain')).toBe(true);
    expect(hasWriteAccess('read')).toBe(false);
    expect(hasWriteAccess(undefined)).toBe(false);
  });
  it('lastLabeler prend le dernier événement labeled du bon label', () => {
    const events = [
      { event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } },
      { event: 'labeled', label: { name: 'bug' }, actor: { login: 'bob' } },
      { event: 'unlabeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } },
      { event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'carol' } },
    ];
    expect(lastLabeler(events, 'sisyphe')).toBe('carol');
    expect(lastLabeler(events, 'absent')).toBeNull();
  });
  it('labelNames accepte chaînes et objets', () => {
    expect(labelNames(['a', { name: 'b' }, { name: undefined }])).toEqual(['a', 'b']);
  });
});
