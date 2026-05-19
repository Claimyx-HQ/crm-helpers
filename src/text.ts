// Generic text and value-comparison helpers. Nothing in here is specific to
// Apollo or Base44 — these utilities are reusable anywhere.

/**
 * Resolve after `ms` milliseconds. Used for backoff sleeps in retry loops.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Strip scheme, `www.` prefix, trailing path, and lowercase a URL or hostname
 * so that `www.foo.com`, `https://foo.com/about`, and `foo.com` all collapse
 * to the same key. Returns an empty string if the input can't be parsed.
 *
 * Used everywhere we produce or compare a domain so external sources (Apollo,
 * user-entered websites, scraped pages) all hash to the same value on lookup.
 */
export function extractDomain(input: string | null | undefined): string {
  if (!input) return '';
  const s = String(input).trim();
  if (!s) return '';
  try {
    const url = s.match(/^https?:\/\//i) ? new URL(s) : new URL(`https://${s}`);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Trim and lowercase an organization name for in-memory keying. Used to dedup
 * stub records when two contacts on the same page share only an org name
 * (no id, no domain) — both should reuse a single stub, not create two.
 */
export function normalizeOrgName(name: string | null | undefined): string {
  return (name || '').trim().toLowerCase();
}

/**
 * Coerce a phone string to E.164. Bare 10-digit inputs are treated as US
 * (`+1` prefix added); already-prefixed inputs (`+44 20 ...`) keep their
 * country code and have non-digits stripped. Returns `''` for empty / non-
 * digit-bearing input.
 *
 * Used as the join key across Apollo (which returns `+1...` already), Quo
 * (which sometimes returns raw 10-digit), and user-entered phone numbers
 * — they all collapse to the same E.164 form so `Lead.filter(phone)`
 * lookups match consistently.
 */
export function normalizePhone(phone: string | null | undefined): string {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw.replace(/[^+\d]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/**
 * Compose a "City, State, Country" string from a partial address object,
 * dropping empty fields.
 */
export function buildLocation(
  obj: { city?: string; state?: string; country?: string } | null | undefined,
): string {
  if (!obj) return '';
  return [obj.city, obj.state, obj.country].filter(Boolean).join(', ');
}

const ALLOWED_EMAIL_STATUSES = new Set([
  'verified',
  'unverified',
  'guessed',
  'unavailable',
]);

/**
 * Coerce an arbitrary email-status string into one of the values the CRM
 * schema accepts, or '' if it doesn't match any. Lowercases on the way in.
 */
export function normalizeEmailStatus(status: string | null | undefined): string {
  if (!status) return '';
  const lower = String(status).toLowerCase();
  return ALLOWED_EMAIL_STATUSES.has(lower) ? lower : '';
}

/**
 * Normalize a value for the {@link isUnchanged} compare. Null, undefined,
 * empty arrays, and empty objects all collapse to `''` so a row with an
 * empty container is treated as equal to a row with no value at all.
 */
export function equalEnough(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length === 0 ? '' : JSON.stringify(v);
  if (typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).length === 0
      ? ''
      : JSON.stringify(v);
  }
  return String(v);
}

/**
 * True iff every non-ignored key in `next` matches the corresponding value in
 * `existing` (compared via {@link equalEnough}). Lets you skip an
 * `entity.update()` call when there's no actual change, which keeps
 * `updated_date` stable and stops inflating the "updated" counter.
 *
 * Extra fields on `existing` (like `id`, `created_date`, user-set fields not
 * present in `next`) are ignored.
 */
export function isUnchanged(
  next: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
  ignoreKeys: ReadonlySet<string> = new Set(),
): boolean {
  if (!existing) return false;
  for (const [key, value] of Object.entries(next)) {
    if (ignoreKeys.has(key)) continue;
    if (equalEnough(value) !== equalEnough(existing[key])) return false;
  }
  return true;
}

// Regex matches strings that look like a phone number: optional leading
// `+`, then digits / spaces / dashes / parens, requiring at least one
// digit followed by 6+ more digit-or-punctuation characters. The followup
// digit-count check guards against pathological inputs like `(((((((1`.
const PHONE_LIKE_NAME = /^[+\s\-()]*\d[\d\s\-()]{6,}$/;

/**
 * True iff `name` looks like a phone number that's been stuffed into a
 * name field. Used to detect Quo's fallback behavior where, when no caller
 * name is known, the caller's phone number ends up as the org/lead name.
 * Storing those as Company names produces useless `+15551234567` rows;
 * callers should fall back to a domain or `Unknown` instead.
 *
 * Threshold: at least 7 actual digits (after stripping non-digits) so a
 * legitimate two-word org name with a stray digit doesn't false-positive.
 */
export function isPhoneLikeName(name: string | null | undefined): boolean {
  if (!name) return false;
  const s = String(name).trim();
  if (!PHONE_LIKE_NAME.test(s)) return false;
  return s.replace(/\D/g, '').length >= 7;
}
