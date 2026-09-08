/**
 * Dernières `lines` lignes, bornées à `maxBytes` (un commentaire GitHub refuse au-delà de 65 536 caractères).
 * Un marqueur indique ce qui a été coupé.
 */
export function tail(text: string, lines = 200, maxBytes = 16_000): string {
  const all = text.split('\n');
  const kept = all.slice(Math.max(0, all.length - lines));
  let out = kept.join('\n');
  const droppedLines = all.length - kept.length;
  if (out.length > maxBytes) out = `…(${out.length - maxBytes} caractères coupés)\n${out.slice(out.length - maxBytes)}`;
  else if (droppedLines > 0) out = `…(${droppedLines} lignes coupées)\n${out}`;
  return out;
}
