// Formatters for Apollo-derived numeric fields. Shared between CompanyDetail
// subcomponents (and anywhere else that renders these primitives) so a tweak
// to the format propagates everywhere at once.

// True when the input is the kind of "absent" we want to render as empty.
// `Number('')` is 0, which is finite, so a bare `Number.isFinite(Number(x))`
// check wouldn't catch empty/whitespace strings (callers in the CRM see
// these all the time when Apollo returns a missing field as `""`).
function isEmptyForFormat(v: number | string | null | undefined): boolean {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

/**
 * Format a USD amount as `$X.YK` / `$X.YM` / `$X.YB`. Returns an empty string
 * for empty / whitespace / null / undefined / non-numeric inputs so blank
 * fields don't render as `$0` (which reads as "no funding" to the user).
 */
export function formatUsd(n: number | string | null | undefined): string {
  if (isEmptyForFormat(n)) return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) {
    return `$${(v / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  if (abs >= 1_000) {
    return `$${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  }
  return `$${v.toFixed(0)}`;
}

/**
 * Format an Apollo growth fraction (e.g. `0.34`) as a signed percent
 * (e.g. `+34%`). Returns an empty string for empty / whitespace / null /
 * undefined / non-numeric inputs.
 */
export function formatPct(frac: number | string | null | undefined): string {
  if (isEmptyForFormat(frac)) return '';
  const v = Number(frac);
  if (!Number.isFinite(v)) return '';
  const sign = v > 0 ? '+' : '';
  return `${sign}${Math.round(v * 100)}%`;
}

/**
 * Tone-class for a growth fraction: green up, red down, neutral flat. The
 * 0.5% dead zone keeps tiny noise from flashing colors.
 *
 * NOTE: the returned strings are Tailwind class names (e.g. `text-emerald-600`,
 * `text-muted-foreground`) — they assume a Tailwind-styled consumer. For
 * non-Tailwind callers, map the returned class to your own tone vocabulary.
 */
export function growthToneClass(
  frac: number | string | null | undefined,
): string {
  if (!Number.isFinite(Number(frac))) return 'text-muted-foreground';
  const v = Number(frac);
  if (v > 0.005) return 'text-emerald-600';
  if (v < -0.005) return 'text-rose-600';
  return 'text-muted-foreground';
}

// Validate `YYYY-MM`: 4 digits, dash, 2 digits, month in 1–12. Anything
// else (alpha months, month > 12, missing dash, wrong width) is rejected
// so we don't produce misleading labels like "Jan 2025" for "2025-13".
const YYYY_MM = /^(\d{4})-(\d{2})$/;

/**
 * Format a `YYYY-MM` month string as a short label (e.g. `Apr 2025`). Returns
 * an empty string for empty / whitespace / null / undefined inputs, and the
 * original (trimmed) input unchanged when it can't be parsed as a valid
 * year-month (months outside 1–12, alpha characters, wrong shape).
 */
export function formatMonth(ym: string | null | undefined): string {
  if (!ym) return '';
  // Trim before the empty check so callers passing `'   '` (e.g. an Apollo
  // payload with a whitespace-padded month) get the same empty-string
  // result as a true empty input — matches `isEmptyForFormat` semantics.
  const s = String(ym).trim();
  if (!s) return '';
  const match = YYYY_MM.exec(s);
  if (!match) return s;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return s;
  const d = new Date(year, month - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
