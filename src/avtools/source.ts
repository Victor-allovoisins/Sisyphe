import type { Logger } from 'pino';
import type { AvToolsLocation } from '../config/machine.js';
import { AVTOOLS_PIN_REF, BASE_REF_PREFIX, type Git } from '../git/git.js';
import { parseRepo, type Forge } from '../github/source.js';
import { parseDeliveryTemplates, type DeliveryTemplates, type ParseResult } from './templates.js';

/** Les conventions d'av-tools qu'un job utilise, et le commit dont elles viennent. */
export interface AvToolsSnapshot {
  sha: string;
  templates: DeliveryTemplates;
  /** Faux : la tête de la branche était injoignable ou invalide, c'est la dernière version validée qui sert. */
  fresh: boolean;
}

/** Ce que le pipeline et doctor attendent de la source ; les tests en passent un faux. */
export interface AvToolsLoader {
  load(): Promise<AvToolsSnapshot | null>;
  pinnedSha(): Promise<string | null>;
}

export interface AvToolsSourceDeps {
  git: Git;
  forge: Pick<Forge, 'getAuthenticatedRemoteUrl'>;
  location: AvToolsLocation;
  log: Logger;
}

export class AvToolsSource implements AvToolsLoader {
  constructor(private readonly d: AvToolsSourceDeps) {}

  /**
   * Rafraîchit le miroir d'av-tools, puis rend la version à utiliser :
   * - la tête de la branche si elle est valide, qui devient alors l'épingle ;
   * - sinon la dernière version validée ;
   * - sinon `null`.
   *
   * Ne lève jamais : une panne ici prive le job d'av-tools, elle ne le fait pas échouer.
   */
  async load(): Promise<AvToolsSnapshot | null> {
    const { repo, branch } = this.d.location;
    let why: string;
    try {
      // Lecture seule : ce jeton ne pourra jamais écrire sur av-tools, quoi qu'il arrive au processus.
      const url = await this.d.forge.getAuthenticatedRemoteUrl(parseRepo(repo), { readOnly: true });
      await this.d.git.ensureMirror(repo, url, `https://github.com/${repo}.git`, [branch]);
      const sha = await this.d.git.resolveRef(repo, `${BASE_REF_PREFIX}${branch}`);
      if (!sha) throw new Error(`branche ${branch} introuvable après le fetch`);
      const parsed = await this.parseAt(sha);
      if (parsed.ok) {
        await this.d.git.pinRef(repo, AVTOOLS_PIN_REF, sha);
        return { sha, templates: parsed.value, fresh: true };
      }
      why = `${branch}@${sha.slice(0, 7)} : ${parsed.reason}`;
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    return this.fromPin(why);
  }

  /** Le SHA épinglé, ou null : pas encore de miroir, ou jamais de version validée. */
  async pinnedSha(): Promise<string | null> {
    return this.d.git.resolveRef(this.d.location.repo, AVTOOLS_PIN_REF).catch(() => null);
  }

  private async parseAt(sha: string): Promise<ParseResult> {
    const text = await this.d.git.readFileAtSha(this.d.location.repo, sha, this.d.location.path);
    if (text === null) return { ok: false, reason: `${this.d.location.path} absent` };
    return parseDeliveryTemplates(text);
  }

  private async fromPin(why: string): Promise<AvToolsSnapshot | null> {
    const pinned = await this.pinnedSha();
    if (pinned) {
      const parsed = await this.parseAt(pinned).catch((err: unknown): ParseResult => ({ ok: false, reason: String(err) }));
      if (parsed.ok) {
        this.d.log.warn({ why, pinned }, 'av-tools : tête de branche inutilisable, repli sur la dernière version validée');
        return { sha: pinned, templates: parsed.value, fresh: false };
      }
    }
    this.d.log.warn({ why }, 'av-tools : aucune version validée disponible');
    return null;
  }
}
