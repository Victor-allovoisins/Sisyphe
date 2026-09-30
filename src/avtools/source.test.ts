import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeIssueSource } from '../../test/fakes/fake-issue-source.js';
import { addCommit, createRemoteRepo } from '../../test/helpers/git-fixture.js';
import { dataPaths } from '../config/paths.js';
import { Git } from '../git/git.js';
import { AvToolsSource } from './source.js';

const REPO = 'ILokYou/IA-Claude-Marketplace';
const PATH = 'plugins/av-tools/skills/av-shared/reference/delivery-templates.yml';
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/av-tools/delivery-templates.yml', import.meta.url));

describe('AvToolsSource', () => {
  let root: string;
  let avRoot: string;
  let git: Git;
  let forge: FakeIssueSource;
  let headSha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-avtools-'));
    avRoot = join(root, 'av');
    const { remotePath, headSha: sha } = await createRemoteRepo(avRoot, { [PATH]: await readFile(FIXTURE, 'utf8') });
    headSha = sha;
    git = new Git(dataPaths(join(root, 'data')));
    forge = new FakeIssueSource();
    forge.remoteUrls[REPO] = remotePath;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const source = () => new AvToolsSource({ git, forge, location: { repo: REPO, branch: 'main', path: PATH }, log: pino({ level: 'silent' }) });

  it('lit la tête valide, l’épingle, et demande un jeton en lecture seule', async () => {
    const s = await source().load();
    expect(s).toMatchObject({ sha: headSha, fresh: true });
    expect(s?.templates.gitmoji.fix).toBe('🐛');
    expect(await source().pinnedSha()).toBe(headSha);
    expect(forge.remoteUrlOpts[REPO]).toEqual({ readOnly: true });
  });

  it('un commit invalide par-dessus : repli sur l’épingle', async () => {
    await source().load();
    await addCommit(avRoot, { [PATH]: 'schema_version: 2\n' });
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: false });
  });

  it('un fetch en échec : repli sur l’épingle', async () => {
    await source().load();
    forge.remoteUrls[REPO] = join(root, 'nulle-part.git');
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: false });
  });

  it('un force-push invalide : l’épingle retient encore le commit perdu', async () => {
    await source().load();
    await addCommit(avRoot, { [PATH]: 'cassé: [\n' }, { amend: true });
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: false });
  });

  it('une nouvelle version valide remplace l’épingle', async () => {
    await source().load();
    const text = await readFile(FIXTURE, 'utf8');
    const next = await addCommit(avRoot, { [PATH]: `${text}\n# relu\n` });
    expect(await source().load()).toMatchObject({ sha: next, fresh: true });
    expect(await source().pinnedSha()).toBe(next);
  });

  it('fichier absent et aucune épingle : null', async () => {
    const other = await createRemoteRepo(join(root, 'vide'), { 'README.md': 'x\n' });
    forge.remoteUrls[REPO] = other.remotePath;
    expect(await source().load()).toBeNull();
    expect(await source().pinnedSha()).toBeNull();
  });
});
