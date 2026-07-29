/**
 * CSV export.
 *
 * Small on purpose. The alternative was a dependency for something that is a
 * quoting rule and a Blob, and the quoting rule is the only part with teeth:
 * a phone number, an agent name with a comma, or a transcript snippet with a
 * newline will all corrupt a naive `join(',')` — and it corrupts it *quietly*,
 * producing a file that opens fine and has the columns shifted from row 400 on.
 */

/**
 * RFC 4180 field quoting: wrap in double quotes when the value contains a
 * comma, a quote or a newline, and double any embedded quotes.
 */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const lines = [columns.map((c) => escapeField(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(c.value(row))).join(','));
  }
  // CRLF per RFC 4180 — Excel on Windows is the main consumer of these files.
  return lines.join('\r\n');
}

/**
 * Triggers a browser download.
 *
 * The BOM is not decoration: without it Excel reads a UTF-8 CSV as the system
 * codepage, so any non-ASCII name or address arrives mojibake'd. Every other
 * consumer ignores it.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
