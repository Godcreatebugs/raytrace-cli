// A unified diff as side-by-side rows, GitHub-style: what was there before
// on the left, what replaced it on the right, line numbers on both sides.
// A run of removed lines followed by added ones pairs up row by row, so a
// replaced line sits next to its replacement instead of in a separate red
// block far from the green one. Pure text work, apart from the view, so
// the pairing can be tested (diff-parse.test.mjs).

/** One side-by-side row. A null text is the blank side of a pure addition
 * (left) or removal (right); `note` is a diff aside ("No newline…"). */
export type SplitRow = {
  oldNo: number | null; oldText: string | null;
  newNo: number | null; newText: string | null;
  note?: string;
};

export type DiffHunk = { header: string; rows: SplitRow[] };

export type ParsedDiff = {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** "Binary files differ": there are no lines to show. */
  binary: boolean;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): ParsedDiff {
  const parsed: ParsedDiff = { hunks: [], additions: 0, deletions: 0, binary: false };
  let hunk: DiffHunk | null = null;
  let oldNo = 0; let newNo = 0;
  let removed: { no: number; text: string }[] = [];
  let added: { no: number; text: string }[] = [];
  const flush = () => {
    if (!hunk) return;
    for (let i = 0; i < Math.max(removed.length, added.length); i += 1) {
      hunk.rows.push({
        oldNo: removed[i]?.no ?? null, oldText: removed[i]?.text ?? null,
        newNo: added[i]?.no ?? null, newText: added[i]?.text ?? null,
      });
    }
    removed = []; added = [];
  };
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, index) => {
    if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') { parsed.binary = true; return; }
    const started = HUNK.exec(line);
    if (started) {
      flush();
      hunk = { header: line.trim(), rows: [] };
      parsed.hunks.push(hunk);
      oldNo = Number(started[1]); newNo = Number(started[2]);
      return;
    }
    if (!hunk) return; // the file headers above the first hunk
    if (line.startsWith('\\')) { flush(); hunk.rows.push({ oldNo: null, oldText: null, newNo: null, newText: null, note: line.slice(1).trim() }); return; }
    if (line.startsWith('-')) { removed.push({ no: oldNo, text: line.slice(1) }); oldNo += 1; parsed.deletions += 1; return; }
    if (line.startsWith('+')) { added.push({ no: newNo, text: line.slice(1) }); newNo += 1; parsed.additions += 1; return; }
    // A context line (" text"), or a blank one the transport stripped. The
    // split's trailing empty piece after the final newline is neither.
    if (line === '' && index === lines.length - 1) return;
    flush();
    const same = line.startsWith(' ') ? line.slice(1) : line;
    hunk.rows.push({ oldNo, oldText: same, newNo, newText: same });
    oldNo += 1; newNo += 1;
  });
  flush();
  return parsed;
}
