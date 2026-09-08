import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';
import { parseMachineConfig } from '../../config/machine.js';
import { dataPaths, defaultDataDir, ensureDataDirs, expandHome, machineConfigPath } from '../../config/paths.js';
import { LAUNCHD_LABEL, installLaunchAgent, plistPath, renderPlist } from '../launchd.js';

export async function setupCommand(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, def?: string): Promise<string> => {
    const answer = (await rl.question(def ? `${question} [${def}] : ` : `${question} : `)).trim();
    return answer || def || '';
  };
  try {
    const dataDir = expandHome(defaultDataDir());
    const appId = Number(await ask('GitHub App ID'));
    const installationId = Number(await ask('Installation ID'));
    const privateKeyPath = expandHome(await ask('Chemin de la clé privée .pem', join(dataDir, 'github-app.pem')));
    const repos = (await ask('Repos à surveiller (owner/repo, séparés par des virgules)')).split(',').map((s) => s.trim()).filter(Boolean);
    const apiKey = await ask('ANTHROPIC_API_KEY (stockée uniquement dans le plist launchd)', process.env.ANTHROPIC_API_KEY);

    const raw = { github: { appId, installationId, privateKeyPath }, repos, dataDir };
    const machine = parseMachineConfig(stringify(raw)); // valide avant d'écrire
    const paths = dataPaths(machine.dataDir);
    await ensureDataDirs(paths);
    await ensureDataDirs(dataPaths(dataDir)); // la config vit toujours sous la racine par défaut
    const configPath = machineConfigPath();
    await writeFile(configPath, stringify(raw), { mode: 0o600 });
    console.log(`Config écrite : ${configPath}`);

    if (process.platform === 'darwin') {
      const plist = renderPlist({
        label: LAUNCHD_LABEL,
        nodePath: process.execPath,
        scriptPath: resolve(process.argv[1]),
        dataDir: paths.root,
        logsDir: paths.logsDir,
        env: { ANTHROPIC_API_KEY: apiKey, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: homedir(), SISYPHE_HOME: paths.root },
      });
      await installLaunchAgent(plist);
      console.log(`Daemon installé et démarré : ${plistPath()}\nLogs : ${paths.logsDir}`);
    } else {
      console.log("Pas macOS : lancez `sisyphe start` sous le superviseur de votre choix, avec ANTHROPIC_API_KEY dans l'environnement.");
    }
    console.log('Vérifiez maintenant avec `sisyphe doctor`.');
  } finally {
    rl.close();
  }
}
