// Bare-bones CSV parser used by the labour-log bulk import (and any future
// admin paste-CSV flow). Handles comma-separated values, double-quoted
// fields with embedded commas, and `""` as an escaped quote inside a
// quoted field. Recognises both LF and CRLF line endings.
//
// LIMITATION (v1): does not support newlines embedded inside quoted
// fields. Inputs we expect (admin-pasted small spreadsheets, ≤500 rows)
// do not produce these in practice; switch to a real parser if/when this
// becomes a constraint.

// Parse a CSV string into a list of row arrays. The first row is treated
// as data — callers that need a header row should slice it off
// themselves (or use `parseCsvWithHeader` below). Blank lines are
// skipped. Returns [] for empty input.
export function parseCsv(input) {
  if (input == null) return [];
  const text = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.length === 0) return [];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // Doubled quote inside a quoted field is an escaped quote.
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      // A quote at the start of an empty field opens quoted mode.
      // Anywhere else, treat as a literal (matches the lenient behaviour
      // of most spreadsheet exports).
      if (field === '') inQuotes = true;
      else field += ch;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      // Skip wholly-blank lines (one empty field, no others).
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // Flush trailing field/row (no terminating newline).
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return rows;
}

// Convenience: split a parsed CSV into { header, rows } where `header` is
// the first row and `rows` is the remainder as objects keyed by header.
// Returns `null` if the input has no rows.
export function parseCsvWithHeader(input) {
  const all = parseCsv(input);
  if (all.length === 0) return null;
  const header = all[0].map(h => h.trim());
  const rows = all.slice(1).map(cols => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cols[i] ?? '';
    return obj;
  });
  return { header, rows };
}
