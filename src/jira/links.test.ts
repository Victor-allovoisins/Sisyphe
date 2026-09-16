import { describe, expect, it } from 'vitest';
import { browseUrl } from './links.js';

describe('browseUrl', () => {
  it('compose l’URL de consultation d’un ticket', () => {
    expect(browseUrl('acme.atlassian.net', 'IOS-886')).toBe('https://acme.atlassian.net/browse/IOS-886');
  });
});
