import pino from 'pino';
import { describe, expect, it } from 'vitest';
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

  it('survit à une erreur de listing', async () => {
    const source = new FakeIssueSource();
    source.listCandidates = async () => { throw new Error('rate limit'); };
    const store = new JobStore(openDatabase(':memory:'));
    await expect(pollOnce({ source, store, machine, log: pino({ level: 'silent' }) })).resolves.toEqual([]);
  });
});
