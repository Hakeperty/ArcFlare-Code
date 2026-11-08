// Line diffs for approval previews: what an edit or write will change.
//
// Edits are usually one hunk, so this trims the lines both sides share at the
// start and end and shows the middle, with a little context around it. It is
// not a general diff (no LCS), which keeps it small and predictable; for the
// rare scattered rewrite it shows one large hunk, which is still accurate.

function splitLines(t) {
  const s = String(t ?? "").replace(/\r\n/g, "\n");
  if (s === "") return [];
  return s.replace(/\n$/, "").split("\n");
}

/**
 * Rows of `{ sign, text }`: sign is " " (context), "-" (removed), "+" (added)
 * or "…" (a gap). `context` lines are kept on each side of the change.
 */
function lineDiff(oldText, newText, { context = 2 } = {}) {
  const o = splitLines(oldText), n = splitLines(newText);
  let head = 0;
  while (head < o.length && head < n.length && o[head] === n[head]) head++;
  let tail = 0;
  while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++;
  const rows = [];
  const before = Math.max(0, head - context);
  if (before > 0) rows.push({ sign: "…", text: `${before} unchanged line${before === 1 ? "" : "s"}` });
  for (let i = before; i < head; i++) rows.push({ sign: " ", text: o[i] });
  for (let i = head; i < o.length - tail; i++) rows.push({ sign: "-", text: o[i] });
  for (let i = head; i < n.length - tail; i++) rows.push({ sign: "+", text: n[i] });
  const afterEnd = Math.min(o.length, o.length - tail + context);
  for (let i = o.length - tail; i < afterEnd; i++) rows.push({ sign: " ", text: o[i] });
  const rest = o.length - afterEnd;
  if (rest > 0) rows.push({ sign: "…", text: `${rest} unchanged line${rest === 1 ? "" : "s"}` });
  return rows;
}

/** Counts of removed and added lines in a lineDiff. */
function diffStat(rows) {
  let del = 0, add = 0;
  for (const r of rows) { if (r.sign === "-") del++; else if (r.sign === "+") add++; }
  return { del, add };
}

/**
 * Cap a row list at `max`, keeping the start, with a note of what was cut.
 * Long diffs are previews, not reviews: the file is on disk afterwards.
 */
function capRows(rows, max = 40) {
  if (rows.length <= max) return rows;
  return [...rows.slice(0, max), { sign: "…", text: `${rows.length - max} more line${rows.length - max === 1 ? "" : "s"} in this change` }];
}

module.exports = { lineDiff, diffStat, capRows, splitLines };
