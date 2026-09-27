import Database from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { CalendarEvent } from '../../src/database/types.ts';
import { localToGoogle } from '../../src/services/google/event-mapper.ts';
import { generateIcs } from '../../src/services/ics/generator.ts';
import { buildUserSessionInvitationText } from '../../src/services/telegram-session/invitation-text.ts';

test('migration 042 adds joined_at and left_at to group_members', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);

  const cols = db.prepare('PRAGMA table_info(group_members)').all() as { name: string; dflt_value: string | null }[];
  const joinedAt = cols.find((c) => c.name === 'joined_at');
  const leftAt = cols.find((c) => c.name === 'left_at');
  expect(joinedAt).toBeDefined();
  expect(leftAt).toBeDefined();
  expect(joinedAt!.dflt_value).toBe("'2026-01-01T00:00:00Z'");
});

test('birthday migrations create expected tables and columns', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);

  const cols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  expect(cols.some((c) => c.name === 'event_type')).toBe(true);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  expect(tables.some((t) => t.name === 'birth_event_metadata')).toBe(true);
  expect(tables.some((t) => t.name === 'birthday_sync_state')).toBe(true);

  const metaCols = db.prepare('PRAGMA table_info(birth_event_metadata)').all() as { name: string }[];
  const names = metaCols.map((c) => c.name);
  expect(names).toContain('event_id');
  expect(names).toContain('celebrant_id');
  expect(names).toContain('birth_year');
  expect(names).toContain('auto_created');
});

test('places marked verified before the bot asked for every place count as unconfirmed', () => {
  // Until 2026-09-27 (#382) verification applied a lone geocode or a remembered mapping on its
  // own and set location_verified = 1, indistinguishable from a place the user confirmed.
  const db = new Database(':memory:');
  runMigrations(
    db,
    migrations.filter((migration) => migration.name < '063'),
  );
  db.exec(`
    INSERT INTO users (telegram_id, timezone) VALUES (101, 'Europe/Belgrade');
    INSERT INTO events (id, user_id, title, start_at, timezone, location, resolved_address, latitude, longitude,
                        google_maps_url, location_verified, venue_name, updated_at, sync_version)
    VALUES (1, 101, 'Dinner', '2026-10-05T17:00:00Z', 'Europe/Belgrade', 'Sonder Dorchol',
            'Strandweg 1, Zeedorp', 51.586, 3.621, 'https://maps.example/nl', 1, 'Strand Hotel',
            '2026-09-20 10:00:00', 3),
           (2, 101, 'Lunch', '2026-10-06T12:00:00Z', 'Europe/Belgrade', 'дома',
            NULL, NULL, NULL, NULL, 0, NULL, '2026-09-20 10:00:00', 1);
  `);
  type PlaceRow = Pick<
    CalendarEvent,
    | 'id'
    | 'location'
    | 'resolved_address'
    | 'latitude'
    | 'longitude'
    | 'google_maps_url'
    | 'location_verified'
    | 'venue_name'
    | 'updated_at'
    | 'sync_version'
  >;
  const place = () =>
    db
      .query<PlaceRow, []>(
        `SELECT id, location, resolved_address, latitude, longitude, google_maps_url, location_verified, venue_name,
                updated_at, sync_version FROM events ORDER BY id`,
      )
      .all();
  const before = place();

  runMigrations(db, migrations);

  // Only the flag changes: the resolved place is kept and nothing looks edited to Google sync
  expect(place()).toEqual(before.map((row) => (row.id === 1 ? { ...row, location_verified: 0 } : row)));
  const legacy = new EventRepository(db).findById(1, 101)!;
  expect(localToGoogle(legacy).location).toBe('Sonder Dorchol');
  expect(generateIcs([legacy])).toContain('LOCATION:Sonder Dorchol\n');
  const invitation = buildUserSessionInvitationText({
    event: legacy,
    inviterTimezone: 'Europe/Belgrade',
    deepLink: 'https://t.me/hypercal_bot?start=invite_1',
    lang: 'en',
  });
  expect(invitation).toContain('📍 Sonder Dorchol\n');
  expect(invitation).not.toContain('Strand');
  expect(invitation).not.toContain('maps.example');

  // A place the user confirms afterwards stays confirmed on the next start
  db.exec('UPDATE events SET location_verified = 1 WHERE id = 1');
  runMigrations(db, migrations);
  expect(new EventRepository(db).findById(1, 101)?.location_verified).toBe(1);
});
