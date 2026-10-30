/**
 * What the proxy keeps of a model request and its response, shared by the
 * local proxy (raytace-proxy.mjs) and RayTrace's hosted evidence service.
 */

// A count is not a credential: usage reports token counts (input_tokens,
// output_tokens_details) under names that look like tokens.
const isCount = (value) => value === null || typeof value === 'number'
  || (typeof value === 'object' && Object.values(value).every(isCount));
const isCredential = (key, value) => /authorization|api[-_]?key|secret|password/i.test(key)
  || (/token/i.test(key) && !isCount(value));

/** The value with every credential-looking field replaced, at any depth. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    isCredential(key, item) ? [key, '[REDACTED]'] : [key, redact(item)],
  ));
}

/** A streamed response as the final response object when the stream carried
 * one (Responses API), else its events; null when nothing parsed. */
export function parseSseResponse(body) {
  const events = [];
  let terminalResponse = null;
  for (const frame of body.toString('utf8').replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const event = JSON.parse(data);
      events.push(event);
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type) && event.response) terminalResponse = event.response;
    } catch { /* retain the raw response hash when an SSE event is not JSON */ }
  }
  if (terminalResponse) return terminalResponse;
  return events.length ? { stream: true, events } : null;
}
