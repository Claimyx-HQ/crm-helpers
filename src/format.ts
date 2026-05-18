// Formatters for Apollo-derived numeric fields. Shared between CompanyDetail
// subcomponents (and anywhere else that renders these primitives) so a tweak
// to the format propagates everywhere at once.

/**
 * Format a USD amount as `$X.YK` / `$X.YM` / `$X.YB`. Falls back to an empty
 * string when the input isn't a finite number so empty fields don't render
 * `$0` (which reads as "no funding" to the user).
 */
export function formatUsd(n: number | string | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
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
 * (e.g. `+34%`). Returns an empty string when the input isn't usable.
 */
export function formatPct(frac: number | string | null | undefined): string {
  if (frac == null || !Number.isFinite(Number(frac))) return '';
  const v = Number(frac);
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

/**
 * Format a `YYYY-MM` month string as a short label (e.g. `Apr 2025`). Returns
 * the original input when it can't be parsed, and an empty string when the
 * input is empty.
 */
export function formatMonth(ym: string | null | undefined): string {
  if (!ym) return '';
  const [y, m] = String(ym).split('-');
  if (!y) return ym;
  const d = new Date(Number(y), (Number(m) || 1) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
