import type { StatusLabel } from './source.js';

export const STATUS_LABELS: readonly StatusLabel[] = ['in-progress', 'blocked', 'done', 'failed'];

export function statusLabelName(trigger: string, status: StatusLabel): string {
  return `${trigger}:${status}`;
}

export function allStatusLabelNames(trigger: string): string[] {
  return STATUS_LABELS.map((s) => statusLabelName(trigger, s));
}

export function statusFromLabel(trigger: string, name: string): StatusLabel | null {
  for (const s of STATUS_LABELS) if (name === statusLabelName(trigger, s)) return s;
  return null;
}

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export function labelDefinitions(trigger: string): LabelDefinition[] {
  return [
    { name: trigger, color: '5319e7', description: 'À traiter par Sisyphe' },
    { name: statusLabelName(trigger, 'in-progress'), color: 'fbca04', description: 'Sisyphe travaille dessus' },
    { name: statusLabelName(trigger, 'blocked'), color: 'd93f0b', description: 'Sisyphe attend une réponse humaine' },
    { name: statusLabelName(trigger, 'done'), color: '0e8a16', description: 'PR ouverte par Sisyphe' },
    { name: statusLabelName(trigger, 'failed'), color: 'b60205', description: 'Sisyphe a échoué, voir la PR draft ou le commentaire' },
  ];
}
