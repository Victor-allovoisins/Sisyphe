#!/usr/bin/env node
import { Command, Option } from 'commander';
import { cancelCommand } from './commands/cancel.js';
import { doctorCommand } from './commands/doctor.js';
import { jiraCommand } from './commands/jira.js';
import { logsCommand } from './commands/logs.js';
import { reportCommand } from './commands/report.js';
import { serviceCommand } from './commands/service.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { uiCommand } from './commands/ui.js';
import { DEFAULT_UI_PORT } from '../ui/server.js';

/** Les seules valeurs que produit réellement le pipeline (voir jobs/pipeline.ts, verify/verify.ts) : pas de phase `deliver` (elle n'écrit pas de fichier dédié dans le jobDir). */
const PHASES = ['triage', 'implement', 'setup', 'verify'] as const;

const program = new Command('sisyphe')
  .description('Transforme des issues GitHub en pull requests avec un agent Claude')
  .version('0.1.0');

program.command('start').description('Lance le daemon au premier plan').option('--once', 'un cycle complet puis sortie').action(startCommand);
program.command('status').description('Jobs actifs et récents').action(statusCommand);
program
  .command('logs')
  .description("Transcript et logs d'un job")
  .argument('<jobId>', 'id complet ou préfixe')
  .addOption(new Option('--phase <name>', 'triage | implement | setup | verify').choices(PHASES))
  .option('--raw', 'fichiers bruts')
  .action(logsCommand);
program
  .command('report')
  .description('KPI en markdown')
  .option('--since <durée>', 'ex. 30d, 2w, 12h', '30d')
  .option('--repo <owner/repo>', 'ne garder que ce repo')
  .action(reportCommand);
program
  .command('ui')
  .description('Interface web locale (127.0.0.1)')
  .option('--port <n>', 'port d’écoute', String(DEFAULT_UI_PORT))
  .option('--read-only', 'observer sans agir : aucune action acceptée')
  .action((opts: { port?: string; readOnly?: boolean }) => uiCommand(opts));
program
  .command('cancel')
  .description("Annule un job actif : via le daemon s'il tourne, sinon en retirant le label trigger")
  .argument('<jobId>')
  .action(cancelCommand);
program
  .command('jira')
  .description('Lit et pilote un ticket Jira : show, transitions, transition, comment, assign, get')
  .argument('<args...>', 'verbe et ses arguments')
  .allowUnknownOption()
  .action((args: string[]) => jiraCommand(args));
program.command('doctor').description("Vérifie l'installation").action(doctorCommand);
program
  .command('setup')
  .description('Configuration interactive et installation du service')
  .option('--reinstall-service', 'saute les questions : réinstalle seulement le service depuis la config existante')
  .action((opts: { reinstallService?: boolean }) => setupCommand(opts));
program
  .command('service')
  .description('Gère le service du daemon (launchd, systemd ou daemon détaché)')
  .argument('<action>', 'status | start | stop | uninstall')
  .action((action: string) => serviceCommand(action));

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
