// Derives /triggers feed events from already-fetched Company rows.
//
// IMPORTANT: this module operates on the NORMALIZED storage shape produced
// by `./apollo.ts` (i.e. `funding_events[].date`, `job_postings[].posted_at`,
// `news_articles[].published_at`). It does NOT parse raw Apollo payloads —
// those use alternate keys (`funded_at`, `publish_date`, etc.) and need to
// be run through `extractFundingEvents` / `extractJobPostings` /
// `extractNewsArticles` first. Passing a raw payload here would silently
// drop events because the date keys won't match.
//
// The {@link CompanyForTriggers} shape is intentionally minimal so this
// module stays framework-agnostic, but the shape names match the normalized
// fields exactly.

/**
 * Lookback window (days) for surfacing funding rounds. Rounds older than this
 * are dropped before the per-company "best" pick.
 */
export const FUNDING_WINDOW_DAYS = 90;

/**
 * Lookback window (days) for surfacing hiring/job-posting events.
 */
export const HIRING_WINDOW_DAYS = 30;

/**
 * Lookback window (days) for surfacing news articles.
 */
export const NEWS_WINDOW_DAYS = 30;

/**
 * Minimum fraction of companies that must have any `news_articles` populated
 * before the News tab is worth surfacing. Below this, the consumer should
 * auto-hide the tab so the feed isn't dominated by a sparse signal.
 */
export const NEWS_COVERAGE_MIN = 0.5;

/**
 * Minimal structural shape this module reads off a Company row. Field names
 * match the NORMALIZED storage shape (post-`extract*` helpers in
 * `./apollo.ts`), not raw Apollo. Only the fields actually used here are
 * declared — keep this local (do NOT import `NormalizedCompany` from
 * `./apollo.ts`) so the module stays decoupled from the Apollo normalizer
 * and any other upstream representation.
 */
export interface CompanyForTriggers {
  id: string;
  funding_events?: { date?: string; [key: string]: unknown }[];
  job_postings?: { posted_at?: string; [key: string]: unknown }[];
  news_articles?: { published_at?: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/**
 * A derived event for the /triggers feed. The `signature` is a deterministic
 * `${type}:${company_id}:${date}` string so a TriggerEventAck row keyed by it
 * still matches after a re-derive.
 */
export interface TriggerEvent {
  type: 'funding' | 'hiring' | 'news';
  company_id: string;
  company: CompanyForTriggers;
  date: string;
  signature: string;
  payload: Record<string, unknown>;
}

function msAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function parseDate(s: string | null | undefined): number {
  if (!s) return NaN;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Build the deterministic signature for a trigger event. Format is
 * `${type}:${company.id}:${date || ""}` — used as the dedupe key on
 * TriggerEventAck rows so a re-derive doesn't produce duplicates.
 */
export function signatureFor(
  type: TriggerEvent['type'],
  company: CompanyForTriggers,
  date: string | null | undefined,
): string {
  return `${type}:${company.id}:${date || ''}`;
}

/**
 * Derive the most recent qualifying funding event per company within the
 * {@link FUNDING_WINDOW_DAYS} window. Reads `funding_events[].date` only —
 * NOT raw Apollo keys like `funded_at`. Only the single most recent event
 * per company is surfaced — multi-round bursts (e.g. a startup with two
 * rounds in 60 days) would otherwise spam the feed. Output is sorted by date
 * descending.
 */
export function deriveFundingEvents(
  companies: CompanyForTriggers[],
): TriggerEvent[] {
  const cutoff = msAgo(FUNDING_WINDOW_DAYS);
  const out: TriggerEvent[] = [];
  for (const c of companies) {
    const events = Array.isArray(c.funding_events) ? c.funding_events : [];
    let best: { date?: string; [key: string]: unknown } | null = null;
    for (const e of events) {
      const t = parseDate(e.date);
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (!best || t > parseDate(best.date)) best = e;
    }
    if (!best) continue;
    out.push({
      type: 'funding',
      company_id: c.id,
      company: c,
      date: best.date || '',
      signature: signatureFor('funding', c, best.date),
      payload: best,
    });
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out;
}

/**
 * Derive the most recent qualifying job-posting event per company within the
 * {@link HIRING_WINDOW_DAYS} window. Reads `job_postings[].posted_at` only
 * — NOT raw Apollo keys like `date`. Output is sorted by date descending.
 */
export function deriveHiringEvents(
  companies: CompanyForTriggers[],
): TriggerEvent[] {
  const cutoff = msAgo(HIRING_WINDOW_DAYS);
  const out: TriggerEvent[] = [];
  for (const c of companies) {
    const postings = Array.isArray(c.job_postings) ? c.job_postings : [];
    let best: { posted_at?: string; [key: string]: unknown } | null = null;
    for (const p of postings) {
      const t = parseDate(p.posted_at);
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (!best || t > parseDate(best.posted_at)) best = p;
    }
    if (!best) continue;
    out.push({
      type: 'hiring',
      company_id: c.id,
      company: c,
      date: best.posted_at || '',
      signature: signatureFor('hiring', c, best.posted_at),
      payload: best,
    });
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out;
}

/**
 * Derive the most recent qualifying news article per company within the
 * {@link NEWS_WINDOW_DAYS} window. Reads `news_articles[].published_at`
 * only — NOT raw Apollo keys like `publish_date`. Output is sorted by date
 * descending.
 */
export function deriveNewsEvents(
  companies: CompanyForTriggers[],
): TriggerEvent[] {
  const cutoff = msAgo(NEWS_WINDOW_DAYS);
  const out: TriggerEvent[] = [];
  for (const c of companies) {
    const articles = Array.isArray(c.news_articles) ? c.news_articles : [];
    let best: { published_at?: string; [key: string]: unknown } | null = null;
    for (const a of articles) {
      const t = parseDate(a.published_at);
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (!best || t > parseDate(best.published_at)) best = a;
    }
    if (!best) continue;
    out.push({
      type: 'news',
      company_id: c.id,
      company: c,
      date: best.published_at || '',
      signature: signatureFor('news', c, best.published_at),
      payload: best,
    });
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out;
}

/**
 * Coverage ratio (0..1) of companies that have any `news_articles` populated
 * at all. Threshold is "has any articles" — not "has fresh ones" — so the
 * value reflects data coverage rather than time-window luck. Compare against
 * {@link NEWS_COVERAGE_MIN} to decide whether to auto-hide the News tab.
 */
export function newsCoverage(companies: CompanyForTriggers[]): number {
  if (companies.length === 0) return 0;
  const withNews = companies.filter(
    (c) => Array.isArray(c.news_articles) && c.news_articles.length > 0,
  ).length;
  return withNews / companies.length;
}
