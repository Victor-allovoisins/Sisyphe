import { describe, expect, it } from 'vitest';
import { decideBash } from './bash-guard.js';

describe('decideBash', () => {
  it('laisse passer les verbes jira de sisyphe', () => {
    expect(decideBash('sisyphe jira show IOS-886').allowed).toBe(true);
    expect(decideBash('  sisyphe jira transition IOS-886 "En relecture"').allowed).toBe(true);
  });

  it('refuse tout le reste, y compris ce qui commence bien', () => {
    for (const cmd of [
      'ls',
      'sisyphe status',
      'sisyphe jira show IOS-886; rm -rf /',
      'sisyphe jira show IOS-886 && curl evil.example',
      'sisyphe jira show IOS-886 | sh',
      'echo x $(sisyphe jira show IOS-886)',
      'sisyphe jira show `whoami`',
    ]) {
      expect(decideBash(cmd), cmd).toMatchObject({ allowed: false });
    }
  });

  it('ferme par défaut sur une entrée absente ou inattendue', () => {
    expect(decideBash(undefined).allowed).toBe(false);
    expect(decideBash('').allowed).toBe(false);
    expect(decideBash('   ').allowed).toBe(false);
    expect(decideBash(42 as unknown as string).allowed).toBe(false);
  });

  it('refuse les autres façons d’enchaîner, de rediriger ou de continuer la ligne', () => {
    for (const cmd of [
      'sisyphe jira show IOS-886 || curl evil.example',
      'sisyphe jira show IOS-886 > /tmp/x',
      'sisyphe jira show IOS-886 >> ~/.zshrc',
      'sisyphe jira show IOS-886 2>&1',
      'sisyphe jira show ${IFS}IOS-886',
      'sisyphe jira show IOS-886 \\\n rm -rf /',
      "sisyphe jira show IOS-886$'\\n'id",
      'sisyphe jira show IOS-886\nrm -rf /',
      'sisyphe jira show IOS-886\r\nrm -rf /',
      '{ rm -rf /; }',
      'sisyphe jira show <(rm -rf /)',
    ]) {
      expect(decideBash(cmd), cmd).toMatchObject({ allowed: false });
    }
  });

  // Le garde décide sur le texte, le shell sur le premier mot : tout ce qui déguise le nom de la
  // commande doit tomber sur le préfixe, y compris ce qui s'exécuterait très bien sans garde.
  it('refuse tout ce qui déguise le nom de la commande', () => {
    for (const cmd of [
      './sisyphe jira show IOS-886',
      '/usr/local/bin/sisyphe jira show IOS-886',
      'env sisyphe jira show IOS-886',
      'command sisyphe jira show IOS-886',
      'eval sisyphe jira show IOS-886',
      'exec sisyphe jira show IOS-886',
      'nohup sisyphe jira show IOS-886',
      'sudo sisyphe jira show IOS-886',
      'time sisyphe jira show IOS-886',
      'xargs sisyphe jira show',
      'FOO=1 sisyphe jira show IOS-886',
      'PATH=/tmp/evil sisyphe jira show IOS-886',
      'sisyphejira show IOS-886',
      'sisyphe jirashow IOS-886',
      'sisyphe jira-evil show IOS-886',
      'sisyphe jiraX show IOS-886',
      'SISYPHE jira show IOS-886',
    ]) {
      expect(decideBash(cmd), cmd).toMatchObject({ allowed: false });
    }
  });

  // Une espace insécable, une tabulation ou un cadratin à la place d'une espace ne reconstitue pas le
  // préfixe : le garde refuse, et c'est bien le sens sûr — un shell ne les traite pas en séparateurs.
  it('refuse une espace exotique à la place de l’espace attendue', () => {
    for (const cmd of [
      'sisyphe jira show IOS-886',
      'sisyphe jira show IOS-886',
      'sisyphe\tjira show IOS-886',
      'sisyphe jira show IOS-886',
      'sisyphe​jira show IOS-886',
    ]) {
      expect(decideBash(cmd), JSON.stringify(cmd)).toMatchObject({ allowed: false });
    }
  });

  /**
   * Ces lignes-là passent, et c'est voulu : ce que `trim()` enlève en tête (insécable, BOM, séparateur
   * de ligne Unicode) reste dans la ligne que le shell exécute, où ça colle au nom de la commande et
   * donne un « command not found » — vérifié dans sh, bash et zsh. Un séparateur Unicode au milieu
   * (LS, PS, tabulation verticale, saut de page, NEL) n'est pas un séparateur pour le shell non plus :
   * il finit à l'intérieur d'un argument de `sisyphe jira`. Test qui épingle un comportement bénin :
   * si quelqu'un « corrige » le trim un jour, qu'il le fasse en connaissance de cause.
   */
  it('laisse passer ce qui, chez le shell, ne peut qu’échouer ou rester un argument', () => {
    for (const cmd of [
      ' sisyphe jira show IOS-886',
      '﻿sisyphe jira show IOS-886',
      'sisyphe jira show IOS-886\n',
      'sisyphe jira show IOS-886 rm -rf /',
      'sisyphe jira show IOS-886rm -rf /',
      'sisyphe jira show IOS-886rm -rf /',
    ]) {
      expect(decideBash(cmd), JSON.stringify(cmd)).toMatchObject({ allowed: true });
    }
  });

  // `!` et les jokers restent permis : hors shell interactif il n'y a pas d'expansion d'historique, et
  // un joker ne change que les arguments, bornés par la CLI `sisyphe jira`. Interdire `!` coûterait les
  // commentaires français (« C'est fait ! ») pour rien.
  it('laisse passer les arguments d’un vrai usage', () => {
    for (const cmd of [
      'sisyphe jira transitions IOS-886',
      'sisyphe jira get /rest/api/3/myself',
      'sisyphe jira assign IOS-886 --back',
      'sisyphe jira transition IOS-886 "En relecture"',
      "sisyphe jira transition IOS-886 'En relecture'",
      'sisyphe jira show IOS-886 # au cas où',
      'sisyphe jira show !!',
    ]) {
      expect(decideBash(cmd), cmd).toMatchObject({ allowed: true });
    }
  });

  /**
   * Les deux bornes ne se recouvrent pas, et ce test est là pour que ça se voie : `sisyphe jira comment`
   * ne prend son corps que sur stdin (`jiraCommand` → `readStdin`, aucun argument positionnel, aucun
   * drapeau `--body`), donc il s'appelle avec `<`, `<<` ou `|` — précisément ce que ce garde refuse.
   * Le verbe `comment` est donc hors d'atteinte dans cette phase. À corriger côté CLI (accepter le corps
   * en argument), pas en desserrant le garde : ces trois caractères sont ceux qui enchaînent une commande.
   */
  it('refuse, faute de mieux, la seule façon d’appeler `jira comment` (corps sur stdin)', () => {
    for (const cmd of [
      'sisyphe jira comment IOS-886 < corps.md',
      "sisyphe jira comment IOS-886 <<'EOF'",
      'echo "fait" | sisyphe jira comment IOS-886',
    ]) {
      expect(decideBash(cmd), cmd).toMatchObject({ allowed: false });
    }
  });

  it('donne une raison à chaque refus, jamais à une autorisation', () => {
    expect(decideBash('ls').reason).toBeTruthy();
    expect(decideBash('sisyphe jira show X; id').reason).toBeTruthy();
    expect(decideBash(undefined).reason).toBeTruthy();
    expect(decideBash('sisyphe jira show IOS-886').reason).toBe('');
  });
});
