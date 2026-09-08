import { createApp, machineConfigPath, type App } from '../../app.js';
import { loadMachineConfig } from '../../config/machine.js';
import { REPO_CONFIG_FILENAME, parseRepoConfig } from '../../config/repo.js';
import { parseRepo } from '../../github/source.js';
import { firstWord, runChecks, which, type Check } from '../checks.js';

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [
    {
      name: 'node',
      run: async () => {
        const major = Number(process.versions.node.split('.')[0]);
        if (major < 24) throw new Error(`Node ${process.versions.node}, il faut 24 ou plus`);
        return process.versions.node;
      },
    },
    { name: 'git', run: () => which('git') },
    { name: 'gitleaks', run: () => which('gitleaks') },
    {
      name: 'ANTHROPIC_API_KEY',
      run: async () => {
        if (!process.env.ANTHROPIC_API_KEY) throw new Error("absente de l'environnement");
        return 'présente';
      },
    },
    {
      name: 'config machine',
      run: async () => {
        const c = await loadMachineConfig(machineConfigPath());
        return `${machineConfigPath()} · ${c.repos.length} repo(s)`;
      },
    },
  ];

  let app: App | null = null;
  try {
    app = await createApp({ needsAgent: false });
  } catch (err) {
    checks.push({ name: 'initialisation', run: async () => { throw err; } });
  }

  if (app) {
    const { github, machine } = app;
    checks.push({
      name: 'GitHub App',
      run: async () => {
        const access = await github.checkAccess();
        const missing = machine.repos.filter((r) => !access.repos.includes(r));
        if (missing.length) throw new Error(`l'installation n'a pas accès à : ${missing.join(', ')}`);
        return `${access.appSlug}, accès à ${access.repos.length} repo(s)`;
      },
    });
    for (const full of machine.repos) {
      const repo = parseRepo(full);
      checks.push({
        name: `${full} · ${REPO_CONFIG_FILENAME}`,
        run: async () => {
          const text = await github.getFileContent(repo, REPO_CONFIG_FILENAME);
          if (text === null) throw new Error('absent sur la branche par défaut');
          const cfg = parseRepoConfig(text);
          const bins = [...new Set([cfg.commands.setup, cfg.commands.build, cfg.commands.test, cfg.commands.lint].filter((c): c is string => !!c).map(firstWord))];
          for (const b of bins) await which(b);
          return `base ${cfg.baseBranch}, outils : ${bins.join(', ')}`;
        },
      });
    }
  }

  const { ok, lines } = await runChecks(checks);
  console.log(lines.join('\n'));
  if (!ok) process.exit(1);
}
