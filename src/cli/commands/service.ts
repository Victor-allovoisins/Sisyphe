import { loadMachineConfig, type MachineConfig } from '../../config/machine.js';
import { dataPaths, machineConfigPath, type DataPaths } from '../../config/paths.js';
import { ControlClient } from '../../daemon/control-client.js';
import { createServiceManager, defaultServiceContext, type ServiceContext, type ServiceManager, type ServiceStatus } from '../../service/index.js';

export const SERVICE_ACTIONS = ['status', 'start', 'stop', 'uninstall'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Fabrique de gestionnaire, injectable : aucun test ne doit toucher launchd ni systemd. */
export type CreateManager = (ctx: ServiceContext) => Promise<ServiceManager>;

export function parseServiceAction(raw: string): ServiceAction {
  if ((SERVICE_ACTIONS as readonly string[]).includes(raw)) return raw as ServiceAction;
  throw new Error(`Action inconnue : ${raw} (attendu ${SERVICE_ACTIONS.join(', ')}).`);
}

/**
 * Gestionnaire de service pour cette config. Le `ControlClient` de la socket de contrôle lui sert à
 * demander un arrêt propre au daemon avant de recourir au signal du gestionnaire.
 */
export function serviceManagerFor(
  paths: DataPaths,
  machine: Pick<MachineConfig, 'agentBackend'>,
  createManager: CreateManager = createServiceManager,
): Promise<ServiceManager> {
  return createManager(defaultServiceContext({ paths, client: new ControlClient(paths.controlSocketPath), machine }));
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
 * `sisyphe service <status|start|stop|uninstall>`. `start` et `stop` affichent le statut obtenu ensuite :
 * c'est là qu'on voit si le daemon tourne vraiment et s'il repartira au boot.
 */
export async function serviceCommand(rawAction: string, deps: { createManager?: CreateManager } = {}): Promise<void> {
  const action = parseServiceAction(rawAction);
  const machine = await loadMachineConfig(machineConfigPath());
  const paths = dataPaths(machine.dataDir);
  const manager = await serviceManagerFor(paths, machine, deps.createManager);
  if (action === 'uninstall') {
    await manager.uninstall();
    console.log('Service désinstallé.');
    return;
  }
  if (action === 'start') await manager.start();
  if (action === 'stop') await manager.stop();
  console.log(formatStatus(await manager.status()));
}
