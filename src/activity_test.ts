// crm-helpers/src/activity_test.ts
import { assertEquals, assert } from 'jsr:@std/assert@^1.0.0';
import {
  WRITE_SOURCES,
  type WriteSource,
  isUserInitiated,
  stampActivity,
} from './activity.ts';

Deno.test('WRITE_SOURCES contains all expected values', () => {
  // Order is canonical; lock it so downstream code can rely on indices.
  assertEquals(WRITE_SOURCES, [
    'user',
    'bulk_admin',
    'cron',
    'llm',
    'apollo_sync',
    'quo_sync',
    'import',
  ] as const);
});

Deno.test('isUserInitiated: true only for "user"', () => {
  assertEquals(isUserInitiated('user'), true);
  assertEquals(isUserInitiated('bulk_admin'), false); // PM decision D2
  assertEquals(isUserInitiated('cron'), false);
  assertEquals(isUserInitiated('llm'), false);
  assertEquals(isUserInitiated('apollo_sync'), false);
  assertEquals(isUserInitiated('quo_sync'), false);
  assertEquals(isUserInitiated('import'), false);
});

Deno.test('stampActivity: user source → stamps last_activity_at', () => {
  const ts = new Date('2026-05-24T10:00:00Z').toISOString();
  const out = stampActivity({ stage: 'Demo Booked' }, ts, 'user');
  assertEquals(out, { stage: 'Demo Booked', last_activity_at: ts });
});

Deno.test('stampActivity: bulk_admin source → does NOT stamp (D2)', () => {
  const ts = new Date('2026-05-24T10:00:00Z').toISOString();
  const out = stampActivity({ owner_id: 'u_1' }, ts, 'bulk_admin');
  assertEquals(out, { owner_id: 'u_1' });
  assert(!('last_activity_at' in out), 'bulk_admin must not stamp');
});

Deno.test('stampActivity: cron / llm / apollo_sync / quo_sync / import → no stamp', () => {
  const ts = new Date('2026-05-24T10:00:00Z').toISOString();
  for (const src of ['cron', 'llm', 'apollo_sync', 'quo_sync', 'import'] as const) {
    const out = stampActivity({ phone: '+15551234567' }, ts, src);
    assert(!('last_activity_at' in out), `${src} must not stamp`);
  }
});

Deno.test('stampActivity: does not mutate the input object', () => {
  const ts = new Date().toISOString();
  const input = { stage: 'New' };
  const out = stampActivity(input, ts, 'user');
  assert(input !== out, 'must return a new object');
  assertEquals(input, { stage: 'New' }, 'input untouched');
});

Deno.test('stampActivity: explicit last_activity_at in updates is preserved when user', () => {
  // If caller already stamped explicitly, don't second-guess them.
  const explicit = '2025-01-01T00:00:00Z';
  const ts = '2026-05-24T10:00:00Z';
  const out = stampActivity({ last_activity_at: explicit }, ts, 'user');
  assertEquals(out.last_activity_at, explicit);
});

Deno.test('stampActivity: explicit last_activity_at is stripped when source != user', () => {
  // Defense in depth — if a bulk-admin writer accidentally includes
  // last_activity_at in its updates payload, we strip it so the AI-override
  // guard in processQuoActivity doesn't misfire.
  const out = stampActivity(
    { stage: 'Closed Lost', last_activity_at: '2026-05-24T10:00:00Z' },
    '2026-05-24T10:00:00Z',
    'bulk_admin',
  );
  assert(!('last_activity_at' in out), 'must strip on non-user source');
  assertEquals(out, { stage: 'Closed Lost' });
});
