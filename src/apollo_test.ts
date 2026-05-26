// crm-helpers/src/apollo_test.ts
//
// Covers the shortcut-phone merge behavior added so we don't silently drop
// Apollo's `corporate_phone` / `mobile_phone` / `direct_phone` / `home_phone`
// / `other_phone` shortcut fields, plus `personal_emails[]`. The structured
// `phone_numbers[]` array and the flat shortcut fields don't always overlap,
// so `normalizeContact` must read both.

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  mapPhoneType,
  mergePhoneShortcuts,
  normalizeContact,
  pickByType,
  type PhoneNumberEntry,
} from './apollo.ts';

Deno.test('mapPhoneType: home_phone / "home" / "residential" → home', () => {
  assertEquals(mapPhoneType('home'), 'home');
  assertEquals(mapPhoneType('home_phone'), 'home');
  assertEquals(mapPhoneType('residential'), 'home');
  assertEquals(mapPhoneType('HOME'), 'home');
});

Deno.test('mergePhoneShortcuts: appends shortcuts missing from array', () => {
  const numbers: PhoneNumberEntry[] = [
    { type: 'mobile', number: '+15551112222', primary: true, status: '' },
  ];
  const out = mergePhoneShortcuts(numbers, {
    corporate_phone: '+14155550000',
    home_phone: '5559998888',
  });
  assertEquals(out.length, 3);
  assertEquals(pickByType(out, 'hq'), '+14155550000');
  assertEquals(pickByType(out, 'home'), '5559998888');
  // Original primary preserved.
  assertEquals(out[0].primary, true);
  assertEquals(out[1].primary, false);
});

Deno.test('mergePhoneShortcuts: dedupes by digits regardless of formatting', () => {
  const numbers: PhoneNumberEntry[] = [
    { type: 'mobile', number: '+1 (415) 555-0000', primary: true, status: 'verified' },
  ];
  const out = mergePhoneShortcuts(numbers, {
    mobile_phone: '4155550000',
    corporate_phone: '4155550000', // same digits as the existing mobile entry
  });
  assertEquals(out.length, 1, 'duplicate shortcuts should not append');
  assertEquals(out[0].type, 'mobile');
});

Deno.test('mergePhoneShortcuts: assigns primary when array starts empty', () => {
  const out = mergePhoneShortcuts([], { corporate_phone: '+14155550000' });
  assertEquals(out.length, 1);
  assertEquals(out[0].primary, true);
  assertEquals(out[0].type, 'hq');
});

Deno.test('mergePhoneShortcuts: empty / blank shortcuts ignored', () => {
  const out = mergePhoneShortcuts([], {
    corporate_phone: '',
    home_phone: undefined,
    other_phone: '   ', // all-whitespace → dedupKey === '' → skipped
  });
  assertEquals(out, []);
});

Deno.test('normalizeContact: captures corporate_phone / home_phone / personal_emails', () => {
  const lead = normalizeContact(
    {
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@acme.com',
      personal_emails: ['jane.personal@gmail.com', 'jane@acme.com', 'jane2@yahoo.com'],
      phone_numbers: [
        { raw_number: '+15551112222', type: 'mobile', is_primary: true },
      ],
      corporate_phone: '+14155550000',
      home_phone: '+15553334444',
      other_phone: '+15556667777',
    },
    'stage-1',
  );

  // Shortcut columns are populated...
  assertEquals(lead.corporate_phone, '+14155550000');
  assertEquals(lead.home_phone, '+15553334444');
  assertEquals(lead.other_phone, '+15556667777');
  assertEquals(lead.mobile_phone, '+15551112222');

  // ...and the structured array carries all four entries with correct types.
  const types = (lead.phone_numbers ?? []).map((p) => p.type).sort();
  assertEquals(types, ['home', 'hq', 'mobile', 'other']);

  // personal_emails is captured, excluding the primary email and blanks.
  assertEquals(lead.personal_emails, ['jane.personal@gmail.com', 'jane2@yahoo.com']);
});

Deno.test('normalizeContact: corporate_phone only via shortcut still surfaces in phone_numbers[]', () => {
  // Regression guard: prior behavior was to read only `contact.phone_numbers`,
  // dropping the shortcut entirely. With the merge this must land as type='hq'.
  const lead = normalizeContact(
    {
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@acme.com',
      corporate_phone: '+14155550000',
    },
    'stage-1',
  );
  assertEquals(lead.corporate_phone, '+14155550000');
  assertEquals(lead.phone, '+14155550000'); // fallback chain
  assertEquals(lead.phone_numbers?.length, 1);
  assertEquals(lead.phone_numbers?.[0].type, 'hq');
  assertEquals(lead.phone_numbers?.[0].primary, true);
});

Deno.test('normalizeContact: phone_numbers[] entry with type=hq still maps to corporate_phone', () => {
  // Apollo can return the HQ line as a structured entry too — make sure both
  // paths produce the same shortcut column.
  const lead = normalizeContact(
    {
      first_name: 'Mei',
      last_name: 'Tan',
      email: 'mei@acme.com',
      phone_numbers: [
        { raw_number: '+14155550000', type: 'corporate', is_primary: true },
      ],
    },
    'stage-1',
  );
  assertEquals(lead.corporate_phone, '+14155550000');
  assertEquals(lead.phone_numbers?.[0].type, 'hq');
});

Deno.test('normalizeContact: empty personal_emails defaults to []', () => {
  const lead = normalizeContact(
    { first_name: 'A', last_name: 'B', email: 'a@b.com' },
    'stage-1',
  );
  assertEquals(lead.personal_emails, []);
});
