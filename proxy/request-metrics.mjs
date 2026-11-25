const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function requestMetrics(row) {
  const payload = row.response?.payload;
  const frames = payload?.events || [];
  const initial = frames.find(e => e.type === 'message_start')?.message?.usage;
  const last = frames.findLast(e => e.usage || e.response?.usage);
  const usage = payload?.usage || { ...initial, ...(last?.usage || last?.response?.usage) };
  const elapsed = row.completed_at ? Date.parse(row.completed_at) - Date.parse(row.timestamp) : NaN;
  return {
    input: numeric(usage.input_tokens ?? usage.prompt_tokens),
    output: numeric(usage.output_tokens ?? usage.completion_tokens),
    cost: row.provider === 'openrouter' ? numeric(usage.cost) : null,
    durationMs: numeric(elapsed),
  };
}
