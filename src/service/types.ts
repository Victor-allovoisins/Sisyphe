import type { DataPaths } from '../config/paths.js';
import type { Exec } from './exec.js';

export type ServiceKind = 'launchd' | 'systemd' | 'none';

export interface ServiceStatus {
  kind: ServiceKind;
  /** Unité/agent chargé dans le gestionnaire de services (toujours false pour `none`). */
  installed: boolean;
  running: boolean;
  /** pid du daemon quand il tourne, sinon null. */
  pid: number | null;
  /** Relancé au boot / après un crash par le gestionnaire (toujours false pour `none`). */
  enabledAtBoot: boolean;
  detail: string;
}

export interface ServiceManager {
  status(): Promise<ServiceStatus>;
  /** Écrit l'unité et la charge, sans démarrer le daemon ; avertissements non bloquants (ex. linger systemd). */
  install(): Promise<{ warnings: string[] }>;
  /** Active au boot et démarre maintenant. */
  start(): Promise<void>;
  /** Arrête maintenant et désactive au boot. */
  stop(): Promise<void>;
  uninstall(): Promise<void>;
}

/** Sous-ensemble structurel de `ControlClient` : un test passe un faux sans socket. */
export interface ServiceClient {
  send(cmd: 'stop'): Promise<unknown>;
  isReachable(): Promise<boolean>;
}

export interface ServiceContext {
  paths: DataPaths;
  nodePath: string;
  scriptPath: string;
  /** Environnement transmis au daemon (PATH, HOME, SISYPHE_HOME, clé API…). */
  env: Record<string, string>;
  client: ServiceClient;
  exec: Exec;
  /** Jamais `homedir()` en direct dans les managers : un test travaille dans un `mkdtemp`. */
  homeDir: string;
  uid: number;
}
