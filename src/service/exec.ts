import { execa } from 'execa';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Lance une commande sans jamais rejeter pour un code de sortie non nul : c'est le manager qui décide. */
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

/**
 * Code conventionnel du shell pour « commande introuvable » : une erreur de lancement (ENOENT…) devient un
 * échec ordinaire. Un process tué par un signal n'a pas non plus de code de sortie (execa expose le nom du
 * signal, pas son numéro) : même 127, faute de mieux — les commandes système lancées ici n'y sont pas exposées.
 */
export const EXIT_NOT_FOUND = 127;

export const realExec: Exec = async (file, args) => {
  const r = await execa(file, args, { reject: false });
  if (r.exitCode === undefined) return { exitCode: EXIT_NOT_FOUND, stdout: r.stdout, stderr: r.stderr || r.shortMessage || '' };
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};
