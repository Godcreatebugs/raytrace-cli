import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from './paths.mjs';
import { openEvidenceStore } from '../proxy/evidence-store.mjs';
import { readTraces } from '../proxy/trace-view.mjs';

const VERSION = '1.0.0';

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeCodeBlock(content, lang = '') {
  const text = String(content ?? '');
  const matches = text.match(/`+/g) || [];
  let maxBackticks = 3;
  for (const m of matches) {
    if (m.length >= maxBackticks) maxBackticks = m.length + 1;
  }
  const fence = '`'.repeat(maxBackticks);
  return `${fence}${lang}\n${text}\n${fence}`;
}

export function formatTraceJson(trace) {
  const exported = {
    version: VERSION,
    exported_at: new Date().toISOString(),
    trace: {
      id: trace.id,
      provider: trace.provider,
      model: trace.model,
      status: trace.status ?? 'unknown',
      title: trace.title ?? null,
      prompt: trace.promptRaw ?? null,
      answer: trace.answer ?? null,
      started_at: trace.startedAt ?? null,
      ended_at: trace.endedAt ?? null,
      sandbox_id: trace.sandboxId ?? null,
      fork_id: trace.forkId ?? null,
      requests: (trace.requests ?? []).map((r) => ({
        id: r.id,
        model: r.model,
        started_at: r.startedAt,
        completed_at: r.completedAt,
        cost: r.cost ?? null,
        input_tokens: r.input_tokens ?? null,
        output_tokens: r.output_tokens ?? null,
      })),
      events: (trace.events ?? []).map((e) => {
        let raw = null;
        if (e.raw) {
          try { raw = typeof e.raw === 'string' ? JSON.parse(e.raw) : e.raw; } catch { raw = e.raw; }
        }
        return {
          kind: e.kind,
          title: e.title,
          status: e.status,
          timestamp: e.timestamp,
          raw,
        };
      }),
      evidence: trace.evidence ?? [],
      call_verifications: trace.callVerifications ?? [],
    },
  };
  return JSON.stringify(exported, null, 2);
}

export function formatTraceMarkdown(trace) {
  const lines = [];
  lines.push(`# Trace ${trace.id}`);
  lines.push('');
  lines.push(`- **Exported:** ${new Date().toISOString()}`);
  lines.push(`- **Format Version:** ${VERSION}`);
  lines.push(`- **Status:** \`${trace.status ?? 'unknown'}\``);
  lines.push(`- **Model:** \`${trace.model ?? 'unknown'}\``);
  lines.push(`- **Provider:** \`${trace.provider ?? 'unknown'}\``);
  lines.push(`- **Started At:** ${trace.startedAt ?? 'unknown'}`);
  lines.push(`- **Ended At:** ${trace.endedAt ?? 'unknown'}`);

  let totalCost = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasTokenData = false;

  for (const r of trace.requests ?? []) {
    if (r.cost != null) totalCost = (totalCost ?? 0) + r.cost;
    if (r.input_tokens != null) { totalInputTokens += r.input_tokens; hasTokenData = true; }
    if (r.output_tokens != null) { totalOutputTokens += r.output_tokens; hasTokenData = true; }
  }

  lines.push(`- **Cost:** \`${totalCost != null ? `$${totalCost.toFixed(4)}` : 'unknown'}\``);
  if (hasTokenData) {
    lines.push(`- **Tokens:** ${totalInputTokens} input · ${totalOutputTokens} output`);
  }

  lines.push('');
  lines.push('## Prompt');
  lines.push('');
  lines.push(escapeHtml(trace.promptRaw || trace.title || '(no prompt recorded)'));
  lines.push('');

  if (trace.answer) {
    lines.push('## Final Answer');
    lines.push('');
    lines.push(escapeHtml(trace.answer));
    lines.push('');
  }

  lines.push('## Timeline & Tool Calls');
  lines.push('');

  if (!trace.events || !trace.events.length) {
    lines.push('*(No events recorded)*');
  } else {
    for (const ev of trace.events) {
      lines.push(`### ${escapeHtml(ev.title)}`);
      lines.push(`- **Kind:** \`${ev.kind}\``);
      lines.push(`- **Status:** \`${ev.status || 'unknown'}\``);
      lines.push(`- **Timestamp:** ${ev.timestamp || 'unknown'}`);

      let rawObj = null;
      if (ev.raw) {
        try { rawObj = typeof ev.raw === 'string' ? JSON.parse(ev.raw) : ev.raw; } catch { rawObj = ev.raw; }
      }

      if (rawObj?.call_id) {
        lines.push(`- **Call ID:** \`${rawObj.call_id}\``);
      }
      if (rawObj?.output !== undefined) {
        lines.push('');
        lines.push('**Output:**');
        lines.push(safeCodeBlock(rawObj.output));
      } else if (rawObj?.arguments || rawObj?.input) {
        lines.push('');
        lines.push('**Arguments:**');
        lines.push(safeCodeBlock(rawObj.arguments || rawObj.input, 'json'));
      }
      lines.push('');
    }
  }

  if (trace.callVerifications && trace.callVerifications.length) {
    lines.push('## Observed Execution');
    lines.push('');
    for (const v of trace.callVerifications) {
      lines.push(`- **${escapeHtml(v.name || 'tool')}** (\`${v.call_id}\`): ` +
        `status=\`${v.status || (v.verified ? 'verified' : 'unverified')}\`` +
        `${v.proposed ? ` · proposed: \`${escapeHtml(v.proposed)}\`` : ''}` +
        `${v.error ? ` · error: \`${escapeHtml(v.error)}\`` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function exportCommand(traceId, { format = 'markdown', output = null } = {}) {
  if (!traceId || !traceId.trim()) {
    throw new Error('Trace ID is required. Usage: raytrace export <trace-id> [--format json|markdown] [--output <file>]');
  }
  const cleanId = traceId.trim();
  const cleanFormat = format?.toLowerCase() ?? 'markdown';
  if (cleanFormat !== 'markdown' && cleanFormat !== 'json') {
    throw new Error(`Invalid format: ${format}. Expected 'markdown' or 'json'.`);
  }

  const dbPath = paths.database;
  if (!existsSync(dbPath)) {
    throw new Error(`No evidence database found at ${dbPath}. Has raytrace been started?`);
  }

  const store = openEvidenceStore(dbPath, { readOnly: true });
  let trace;
  try {
    const traces = await readTraces(store, { turnId: cleanId, includeHistory: true, evidence: true });
    trace = traces.find((t) => t.id === cleanId) || traces[0];
  } finally {
    store.close();
  }

  if (!trace) {
    throw new Error(`Trace not found: ${cleanId}`);
  }

  const content = cleanFormat === 'json' ? formatTraceJson(trace) : formatTraceMarkdown(trace);

  if (output) {
    const outPath = resolve(output);
    if (existsSync(outPath)) {
      throw new Error(`File already exists: ${outPath}. Refusing to overwrite.`);
    }
    writeFileSync(outPath, content, { mode: 0o600 });
    return content;
  }

  console.log(content);
  return content;
}
