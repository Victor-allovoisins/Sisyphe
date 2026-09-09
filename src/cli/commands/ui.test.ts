import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PORT } from '../../ui/server.js';
import { parsePort } from './ui.js';

describe('parsePort', () => {
  it('sans option, le port par défaut', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_UI_PORT);
  });

  it('accepte un entier dans la plage des ports', () => {
    expect(parsePort('7799')).toBe(7799);
  });

  it('refuse ce qui n’est pas un port', () => {
    for (const bad of ['0', '70000', '-1', 'abc', '80.5']) {
      expect(() => parsePort(bad)).toThrow(/Port invalide/);
    }
  });
});
