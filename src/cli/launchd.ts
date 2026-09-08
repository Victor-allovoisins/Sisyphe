import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  const envXml = Object.entries(i.env)
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
  <key>StandardOutPath</key><string>${esc(i.logsDir)}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${esc(i.logsDir)}/launchd.err.log</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
`;
}

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** Écrit le plist et (re)charge l'agent dans le domaine de l'utilisateur courant. */
export async function installLaunchAgent(plist: string): Promise<void> {
  const p = plistPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, plist);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execa('launchctl', ['bootout', domain, p], { reject: false });
  await execa('launchctl', ['bootstrap', domain, p]);
}
