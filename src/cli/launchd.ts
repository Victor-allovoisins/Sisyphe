import { execa } from 'execa';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const LAUNCHD_LABEL = 'com.sisyphe.daemon';

export interface PlistInput {
  label: string;
  nodePath: string;
  scriptPath: string;
  dataDir: string;
  logsDir: string;
  env: Record<string, string>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPlist(i: PlistInput): string {
  // Le PATH transmis à launchd n'hérite d'aucun shell (nvm/mise, homebrew...) : on préfixe avec le
  // répertoire du node qui exécute sisyphe lui-même, sinon le script planté au premier lancement.
  const nodeDir = dirname(i.nodePath);
  const dirs = [nodeDir, ...(i.env.PATH ? i.env.PATH.split(':') : [])].filter(Boolean);
  const env = { ...i.env, PATH: [...new Set(dirs)].join(':') };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(i.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(i.nodePath)}</string>
    <string>${esc(i.scriptPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${esc(i.dataDir)}</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${esc(i.logsDir)}/launchd.err.log</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
`;
}

export interface LaunchdStatus {
  /** null : plateforme sans launchd (l'agent n'existe que sur macOS). */
  loaded: boolean | null;
  /** null : jamais lancé depuis le chargement — ne pas inventer un 0, ce serait un faux succès. */
  lastExitCode: number | null;
  detail: string;
}

/** Extrait `state` et `last exit code` de la sortie de `launchctl print` (fonction pure, testable). */
export function parseLaunchctlPrint(stdout: string): { state: string; lastExitCode: number | null } {
  const state = /state = (\S+)/.exec(stdout)?.[1] ?? '?';
  const raw = /last exit code = (-?\d+)/.exec(stdout)?.[1];
  return { state, lastExitCode: raw === undefined ? null : Number(raw) };
}

/** État de l'agent launchd de l'utilisateur courant. Ne lève jamais : l'UI affiche un avertissement, pas une erreur. */
export async function probeLaunchd(): Promise<LaunchdStatus> {
  if (process.platform !== 'darwin') return { loaded: null, lastExitCode: null, detail: 'launchd : macOS uniquement' };
  const uid = process.getuid?.() ?? 501;
  const r = await execa('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`], { reject: false }).catch(() => null);
  if (!r || r.exitCode !== 0) return { loaded: false, lastExitCode: null, detail: 'agent launchd non chargé' };
  const { state, lastExitCode } = parseLaunchctlPrint(r.stdout);
  return { loaded: true, lastExitCode, detail: lastExitCode === null ? `state = ${state}` : `state = ${state}, last exit code = ${lastExitCode}` };
}

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** Écrit le plist et (re)charge l'agent dans le domaine de l'utilisateur courant. */
export async function installLaunchAgent(plist: string): Promise<void> {
  const p = plistPath();
  await mkdir(dirname(p), { recursive: true });
  // `writeFile(mode)` n'est appliqué qu'à la création : un fichier déjà présent (relance de setup)
  // garde ses permissions d'origine sans le chmod explicite.
  await writeFile(p, plist, { mode: 0o600 });
  await chmod(p, 0o600);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execa('launchctl', ['bootout', domain, p], { reject: false });
  let result = await execa('launchctl', ['bootstrap', domain, p], { reject: false });
  if (result.exitCode !== 0) {
    await delay(500);
    result = await execa('launchctl', ['bootstrap', domain, p], { reject: false });
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.shortMessage || `code ${result.exitCode}`;
    throw new Error(
      `Impossible de charger l'agent launchd : ${detail}. Essayer « launchctl bootout gui/$UID/${LAUNCHD_LABEL} » puis relancer sisyphe setup.`,
    );
  }
}
