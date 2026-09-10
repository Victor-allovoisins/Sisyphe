import { setTimeout as delay } from 'node:timers/promises';
import { loadMachineConfig, type MachineConfig } from '../../config/machine.js';
import { dataPaths, machineConfigPath, type DataPaths } from '../../config/paths.js';
import { ControlClient } from '../../daemon/control-client.js';
import { createServiceManager, defaultServiceContext, type ServiceContext, type ServiceManager, type ServiceStatus } from '../../service/index.js';

export const SERVICE_ACTIONS = ['status', 'start', 'stop', 'uninstall'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Fabrique de gestionnaire, injectable : aucun test ne doit toucher launchd ni systemd. */
export type CreateManager = (ctx: ServiceContext) => Promise<ServiceManager>;

/**
 * Attente maximale avant d'afficher le statut d'un `start`/`stop` : la socket de contrôle répond « ok »
 * avant que le daemon n'ait commencé son arrêt, et launchd met un instant à faire démarrer le job.
 */
const SETTLE_MS = 3_000;
const SETTLE_POLL_MS = 100;

/** Ce dont setup a besoin quand rien n'est installable : le daemon détaché reste possible, mais il ne survit pas au boot. */
export const NONE_SERVICE_HINT =
  'Aucun service géré sur cette plateforme — lancer `sisyphe service start` pour un daemon détaché (il ne survivra pas au redémarrage).';

export function parseServiceAction(raw: string): ServiceAction {
  if ((SERVICE_ACTIONS as readonly string[]).includes(raw)) return raw as ServiceAction;
  throw new Error(`Action inconnue : ${raw} (attendu ${SERVICE_ACTIONS.join(', ')}).`);
}

export interface ServiceManagerOptions {
  createManager?: CreateManager;
  /** Clé transmise au service sans passer par `process.env` (setup vient de la recueillir). */
  apiKey?: string;
}

/**
 * Gestionnaire de service pour cette config. Le `ControlClient` de la socket de contrôle lui sert à
 * demander un arrêt propre au daemon avant de recourir au signal du gestionnaire.
 */
export function serviceManagerFor(
  paths: DataPaths,
  machine: Pick<MachineConfig, 'agentBackend'>,
  opts: ServiceManagerOptions = {},
): Promise<ServiceManager> {
  const create = opts.createManager ?? createServiceManager;
  return create(defaultServiceContext({ paths, client: new ControlClient(paths.controlSocketPath), machine, apiKey: opts.apiKey }));
}

export interface ServiceTarget {
  machine: MachineConfig;
  paths: DataPaths;
  manager: ServiceManager;
}

/** Config machine, chemins et gestionnaire : le point de départ commun de service, setup, doctor et ui. */
export async function loadServiceTarget(opts: ServiceManagerOptions = {}): Promise<ServiceTarget> {
  const machine = await loadMachineConfig(machineConfigPath());
  const paths = dataPaths(machine.dataDir);
  return { machine, paths, manager: await serviceManagerFor(paths, machine, opts) };
}

/** Une ligne `clé : valeur` par champ ; `pid` absent s'écrit `-` plutôt que `null`. */
export function formatStatus(s: ServiceStatus): string {
  return [
    `kind : ${s.kind}`,
    `installed : ${s.installed}`,
    `running : ${s.running}`,
    `pid : ${s.pid ?? '-'}`,
    `enabledAtBoot : ${s.enabledAtBoot}`,
    `detail : ${s.detail}`,
  ].join('\n');
}

/**
 * Statut une fois l'action prise en compte : `stop` rend la main dès que le daemon a accusé réception
 * sur la socket, bien avant d'avoir fini — afficher le statut tout de suite dirait « running : true ».
 * Au-delà du délai, on affiche ce qu'on voit : c'est déjà l'information utile.
 */
async function settledStatus(manager: ServiceManager, running: boolean, settleMs: number): Promise<ServiceStatus> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const status = await manager.status();
    if (status.running === running || Date.now() >= deadline) return status;
    await delay(Math.min(SETTLE_POLL_MS, settleMs));
  }
}

export interface ServiceCommandOptions extends ServiceManagerOptions {
  /** Attente max de la bascule `running` après start/stop ; raccourcie en test. */
  settleMs?: number;
}

/**
 * `sisyphe service <status|start|stop|uninstall>`. `start` et `stop` affichent le statut une fois
 * l'action prise en compte : c'est là qu'on voit si le daemon tourne vraiment et s'il repartira au boot.
 */
export async function serviceCommand(rawAction: string, opts: ServiceCommandOptions = {}): Promise<void> {
  const action = parseServiceAction(rawAction);
  const { manager } = await loadServiceTarget(opts);
  const settleMs = opts.settleMs ?? SETTLE_MS;
  if (action === 'uninstall') {
    // Plateforme sans service géré : rien n'a été installé, ce n'est pas une erreur.
    if ((await manager.status()).kind === 'none') {
      console.log(NONE_SERVICE_HINT);
      return;
    }
    await manager.uninstall();
    console.log('Service désinstallé.');
    return;
  }
  if (action === 'status') {
    console.log(formatStatus(await manager.status()));
    return;
  }
  if (action === 'start') await manager.start();
  else await manager.stop();
  console.log(formatStatus(await settledStatus(manager, action === 'start', settleMs)));
}
