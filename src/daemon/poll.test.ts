import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FakeIssueSource } from '../../test/fakes/fake-issue-source.js';
import { parseMachineConfig } from '../config/machine.js';
import { parseRepo } from '../github/source.js';
import { openDatabase } from '../store/db.js';
import { JobStore } from '../store/jobs.js';
import { pollOnce } from './poll.js';

const repo = parseRepo('acme/demo');
const machine = parseMachineConfig('github:\n  appId: 1\n  installationId: 1\n  privateKeyPath: /x\nrepos:\n  - acme/demo\n');

describe('pollOnce', () => {
  it('crée un job par candidate autorisée, ignore les autres, ne duplique pas', async () => {
    const source = new FakeIssueSource();
    source.permissions.alice = 'write';
    source.addIssue(repo, { number: 1, title: 'ok', labeledBy: 'alice' });
    source.addIssue(repo, { number: 2, title: 'refusé', labeledBy: 'mallory' });
    source.addIssue(repo, { number: 3, title: 'déjà en statut', labels: ['sisyphe', 'sisyphe:done'] });
    const store = new JobStore(openDatabase(':memory:'));
    const deps = { source, store, machine, log: pino({ level: 'silent' }) };

    const created = await pollOnce(deps);
    expect(created.map((j) => j.issueNumber)).toEqual([1]);
    expect(created[0].issueTitle).toBe('ok');
    expect(source.labelsOf({ repo, number: 2 })).toEqual([]);
    expect(source.commentsOf({ repo, number: 2 })[0]).toContain('@mallory');

    expect(await pollOnce(deps)).toEqual([]);
    expect(store.listActive()).toHaveLength(1);
  });

  it('label reposé par notre propre App : ni commentaire ni retrait de label, la relance a lieu', async () => {
    const source = new FakeIssueSource();
    source.permissions.alice = 'write';
    source.addIssue(repo, { number: 9, title: 'relancée', author: 'alice' });
    // Ce que fait `enqueue`/`retry` depuis l'interface : c'est l'App qui pose le label trigger.
    await source.addTriggerLabel({ repo, number: 9 });
    const store = new JobStore(openDatabase(':memory:'));
    const deps = { source, store, machine, log: pino({ level: 'silent' }) };

    const created = await pollOnce(deps);
    expect(created.map((j) => j.issueNumber)).toEqual([9]);
    expect(source.labelsOf({ repo, number: 9 })).toEqual(['sisyphe']);
    expect(source.commentsOf({ repo, number: 9 })).toEqual([]);
    expect(source.calls).not.toContain('removeTriggerLabel');
  });

  it("canTrigger transitoire (slug de l'App illisible…) : issue ignorée, ni commentaire ni retrait", async () => {
    const source = new FakeIssueSource();
    source.addIssue(repo, { number: 10, title: 'transitoire' });
    source.canTrigger = async () => { throw new Error('GET /app a échoué'); };
    const store = new JobStore(openDatabase(':memory:'));

    await expect(pollOnce({ source, store, machine, log: pino({ level: 'silent' }) })).resolves.toEqual([]);
    expect(source.labelsOf({ repo, number: 10 })).toEqual(['sisyphe']);
    expect(source.commentsOf({ repo, number: 10 })).toEqual([]);
  });

  it('survit à une erreur de listing', async () => {
    const source = new FakeIssueSource();
    source.listCandidates = async () => { throw new Error('rate limit'); };
    const store = new JobStore(openDatabase(':memory:'));
    await expect(pollOnce({ source, store, machine, log: pino({ level: 'silent' }) })).resolves.toEqual([]);
  });

  it("réessaie le retrait du label sans jamais commenter deux fois si removeTriggerLabel échoue une fois", async () => {
    const source = new FakeIssueSource();
    source.addIssue(repo, { number: 2, title: 'refusé', labeledBy: 'mallory' });
    const originalRemove = source.removeTriggerLabel.bind(source);
    let calls = 0;
    source.removeTriggerLabel = async (ref) => {
      calls += 1;
      if (calls === 1) throw new Error('403 transitoire');
      return originalRemove(ref);
    };
    const store = new JobStore(openDatabase(':memory:'));
    const deps = { source, store, machine, log: pino({ level: 'silent' }) };

    await pollOnce(deps);
    expect(source.labelsOf({ repo, number: 2 })).toEqual(['sisyphe']);
    expect(source.commentsOf({ repo, number: 2 })).toEqual([]);

    await pollOnce(deps);
    expect(source.labelsOf({ repo, number: 2 })).toEqual([]);
    expect(source.commentsOf({ repo, number: 2 })).toHaveLength(1);
    expect(source.commentsOf({ repo, number: 2 })[0]).toContain('@mallory');
  });

  it("une erreur de listing sur un repo n'empêche pas la création d'un job sur un autre", async () => {
    const machineMulti = parseMachineConfig(
      'github:\n  appId: 1\n  installationId: 1\n  privateKeyPath: /x\nrepos:\n  - acme/demo\n  - acme/other\n',
    );
    const repoB = parseRepo('acme/other');
    const source = new FakeIssueSource();
    source.permissions.alice = 'write';
    source.addIssue(repoB, { number: 5, title: 'ok-b', labeledBy: 'alice' });
    const originalListCandidates = source.listCandidates.bind(source);
    source.listCandidates = async (r) => {
      if (r.full === repo.full) throw new Error('rate limit');
      return originalListCandidates(r);
    };
    const store = new JobStore(openDatabase(':memory:'));
    const deps = { source, store, machine: machineMulti, log: pino({ level: 'silent' }) };

    const created = await pollOnce(deps);
    expect(created).toHaveLength(1);
    expect(created[0].repo).toBe(repoB.full);
    expect(created[0].issueNumber).toBe(5);
  });

  it("une violation de l'index unique jobs_active_issue est bénigne : pas de rejet, pas de doublon", async () => {
    const source = new FakeIssueSource();
    source.permissions.alice = 'write';
    source.addIssue(repo, { number: 7, title: 'dup', labeledBy: 'alice' });
    const store = new JobStore(openDatabase(':memory:'));
    store.create({ repo: repo.full, issueNumber: 7, issueTitle: 'déjà actif' });
    vi.spyOn(store, 'findActiveByIssue').mockReturnValue(null);
    const deps = { source, store, machine, log: pino({ level: 'silent' }) };

    await expect(pollOnce(deps)).resolves.toEqual([]);
    expect(store.listActive()).toHaveLength(1);
  });
});
