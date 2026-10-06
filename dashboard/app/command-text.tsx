export const parsed = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
export function span(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** A command on one line: long ones (heredocs, env preambles, pipelines)
 * are cut with an ellipsis, and the full text is one hover away. Newlines
 * are shown as ⏎ so a multi-line command still reads as one line. */
export function CommandText({ text }: { text: string }) {
  const oneLine = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return <code className="exec-cmd" title={text}>{oneLine}</code>;
}
