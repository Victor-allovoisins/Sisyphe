import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIssueSource } from '../../test/fakes/fake-issue-source.js';
import { addCommit, createRemoteRepo } from '../../test/helpers/git-fixture.js';
import { dataPaths } from '../config/paths.js';
import { AVTOOLS_PIN_REF, Git } from '../git/git.js';
import { AvToolsSource } from './source.js';

const REPO = 'ILokYou/IA-Claude-Marketplace';
const PATH = 'plugins/av-tools/skills/av-shared/reference/delivery-templates.yml';
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/av-tools/delivery-templates.yml', import.meta.url));

/** Un `Git` dont la lecture d'un fichier laisse une autre lecture d'av-tools faire son travail, une seule fois. */
class RacingGit extends Git {
  constructor(paths: ConstructorParameters<typeof Git>[0], private interleave: (() => Promise<void>) | null) {
    super(paths);
  }

  override async readFileAtSha(repo: string, sha: string, path: string): Promise<string | null> {
    const text = await super.readFileAtSha(repo, sha, path);
    const run = this.interleave;
    this.interleave = null;
    if (run) await run();
    return text;
  }
}

/** Journal capturé : chaque entrée est un objet pino déjà décodé. */
function capture(level: 'debug' | 'warn'): { log: pino.Logger; entries: Array<{ level: number } & Record<string, unknown>> } {
  const entries: Array<{ level: number } & Record<string, unknown>> = [];
  const log = pino({ level }, { write: (line: string) => { entries.push(JSON.parse(line) as { level: number }); } });
  return { log, entries };
}

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

  it('une tête déjà épinglée n’écrit rien', async () => {
    await source().load();
    const pin = vi.spyOn(git, 'pinRef');
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: true });
    expect(pin).not.toHaveBeenCalled();
  });

  it('deux lectures concurrentes : l’épingle ne recule pas, la plus lente garde sa version', async () => {
    await source().load();
    const text = await readFile(FIXTURE, 'utf8');
    const slow = await addCommit(avRoot, { [PATH]: `${text}\n# lente\n` });
    let winner = '';
    const racing = new RacingGit(dataPaths(join(root, 'data')), async () => {
      // Pendant que la lecture lente valide `slow`, une autre a lu, épinglé la version suivante.
      winner = await addCommit(avRoot, { [PATH]: `${text}\n# rapide\n` });
      await git.ensureMirror(REPO, forge.remoteUrls[REPO] as string, `https://github.com/${REPO}.git`, ['main']);
      await git.pinRef(REPO, AVTOOLS_PIN_REF, winner, headSha);
    });
    const { log, entries } = capture('debug');
    const s = await new AvToolsSource({ git: racing, forge, location: { repo: REPO, branch: 'main', path: PATH }, log }).load();
    expect(s).toMatchObject({ sha: slow, fresh: true });
    expect(await source().pinnedSha()).toBe(winner);
    expect(entries.filter((e) => e.level === 20)).toHaveLength(1);
    expect(entries.filter((e) => e.level >= 40)).toEqual([]);
  });

  it('épingle présente mais invalide à son tour : le journal du repli dit pourquoi', async () => {
    const bad = await addCommit(avRoot, { [PATH]: 'schema_version: 2\n' });
    await git.ensureMirror(REPO, forge.remoteUrls[REPO] as string, `https://github.com/${REPO}.git`, ['main']);
    await git.pinRef(REPO, AVTOOLS_PIN_REF, bad, null);
    const { log, entries } = capture('warn');
    const s = await new AvToolsSource({ git, forge, location: { repo: REPO, branch: 'main', path: PATH }, log }).load();
    expect(s).toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pinned: bad, why: expect.stringContaining('schema_version'), pinReason: expect.stringContaining('schema_version') });
  });

  it('fichier absent et aucune épingle : null', async () => {
    const other = await createRemoteRepo(join(root, 'vide'), { 'README.md': 'x\n' });
    forge.remoteUrls[REPO] = other.remotePath;
    expect(await source().load()).toBeNull();
    expect(await source().pinnedSha()).toBeNull();
  });
});
