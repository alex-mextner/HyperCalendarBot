import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { renderIntentCatalogue } from '../../../scripts/intent-catalogue-page.ts';
import { auditDefinition, collectIntentSnapshot } from '../../../src/services/intent/catalog-audit.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE intents (id INTEGER PRIMARY KEY, canonical_name TEXT, phrases TEXT, trigger_words TEXT, pattern TEXT, workflow TEXT, format TEXT, status TEXT, created_at TEXT);
  CREATE TABLE user_action_log(action_type TEXT, action_name TEXT, success INTEGER, created_at TEXT);
  CREATE TABLE chat_history(id INTEGER PRIMARY KEY, role TEXT, content TEXT, created_at TEXT);`);
  const first = seedIntents[0]!;
  db.query('INSERT INTO intents VALUES(1,?,?,?,?,?,?,?,?)').run(
    first.canonical_name,
    JSON.stringify(first.phrases),
    JSON.stringify(first.trigger_words),
    first.pattern,
    JSON.stringify(first.workflow),
    'text',
    'approved',
    '2026-03-01 00:00:00',
  );
  db.query('INSERT INTO intents VALUES(2,?,?,?,?,?,?,?,?)').run(
    'private_client_SECRET',
    '["SECRET user phrase"]',
    '[]',
    null,
    '{"tools":[{"name":"obsolete_tool","input":{}}]}',
    'text',
    'pending',
    '2026-03-02 00:00:00',
  );
  db.exec(`INSERT INTO user_action_log VALUES('intent_match','show_today',1,'2026-03-03 00:00:00');
  INSERT INTO user_action_log VALUES('ai_tool','create_event',0,'2026-03-03 00:00:00');
  INSERT INTO chat_history VALUES(1,'user','что у меня сегодня','2026-03-03 00:00:00');
  INSERT INTO chat_history VALUES(2,'user','SECRET user phrase','2026-03-03 00:00:01');`);
  return db;
}

test('six shipped definitions are import-safe and actual schema issues are visible', () => {
  expect(seedIntents.map((x) => x.canonical_name)).toEqual([
    'show_today',
    'show_tomorrow',
    'show_week',
    'free_slots_today',
    'search_events_by_query',
    'create_event_named_tomorrow',
  ]);
  expect(auditDefinition(seedIntents[0]!).schemaValid).toBe(true);
  expect(auditDefinition(seedIntents[5]!).schemaValid).toBe(false);
  expect(auditDefinition(seedIntents[4]!).examplesMissingCaptures).toBe(0);
  expect(auditDefinition(seedIntents[4]!).examplesMatched).toBe(3);
});

test('snapshot is read-only, distinguishes missing from zero and never equates match with success', () => {
  const db = fixture();
  db.exec('PRAGMA query_only=ON');
  try {
    const s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.totals).toMatchObject({ database: 2, approved: 1, pending: 1, rejected: 0, seed: 6 });
    expect(s.seeds[0]).toMatchObject({ present: true, definition: 'same', recordedMatches: 1 });
    expect(s.seeds[1]).toMatchObject({ present: false, definition: 'absent', recordedMatches: 0 });
    expect(s.statistics.executionSuccessRate).toBeNull();
    expect(s.statistics.replay).toMatchObject({ retainedUserMessages: 2, examined: 2, matched: 1 });
    expect(db.query('SELECT COUNT(*) n FROM intents').get()).toEqual({ n: 2 });
  } finally {
    db.close();
  }
});

test('private values excluded and DB names anonymized by default', () => {
  const db = fixture();
  try {
    const text = JSON.stringify(collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' }));
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('private_client');
    expect(text).not.toContain('source_message');
    expect(text).not.toContain('user_id');
  } finally {
    db.close();
  }
});

test('semantic drift ignores JSON key order but sees workflow edits and status separately', () => {
  const db = fixture();
  try {
    db.exec("UPDATE intents SET status='rejected' WHERE id=1");
    let s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.seeds[0]!.definition).toBe('same');
    expect(s.seeds[0]!.status).toBe('rejected');
    db.exec(`UPDATE intents SET workflow='{"steps":[{"call":"get_history","input":{}}]}' WHERE id=1`);
    s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.seeds[0]!.definition).toBe('changed');
    expect(s.seeds[0]!.changedFields).toContain('workflow');
  } finally {
    db.close();
  }
});

test('missing telemetry is null, never manufactured zero, and history is bounded', () => {
  const db = fixture();
  try {
    let s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic', maxHistory: 1 });
    expect(s.statistics.replay.truncated).toBe(true);
    expect(s.statistics.replay.examined).toBe(1);
    db.exec('DROP TABLE user_action_log; DROP TABLE chat_history');
    s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.statistics.recordedMatches).toBeNull();
    expect(s.seeds[0]!.recordedMatches).toBeNull();
    expect(s.statistics.replay.available).toBe(false);
  } finally {
    db.close();
  }
});

test('standalone page escapes untrusted text, no remote assets or private details', () => {
  const db = fixture();
  try {
    const s = collectIntentSnapshot(db, seedIntents, { sourceRevision: '</script><img src=x onerror=alert(1)>' });
    const html = renderIntentCatalogue(s);
    expect(html).toContain('show_today');
    expect(html).toContain('не означает успешное выполнение');
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('onerror=alert');
    expect(html).not.toContain('SECRET');
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=["']https?:/i);
  } finally {
    db.close();
  }
});

test('role user activity rows are not natural-language messages for replay', () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO chat_history VALUES(3,'user','{"kind":"command","name":"today"}','2026-03-03 00:00:02');
    INSERT INTO chat_history VALUES(4,'user','{"kind":"button","label":"что у меня сегодня"}','2026-03-03 00:00:03');`);
    const s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.statistics.replay).toMatchObject({ retainedUserMessages: 4, examined: 2, skippedActivity: 2, matched: 1 });
  } finally {
    db.close();
  }
});

test('report bounds size instead of loading an unbounded intent catalogue', () => {
  const db = fixture();
  try {
    db.exec(`WITH RECURSIVE n(x) AS(SELECT 3 UNION ALL SELECT x+1 FROM n WHERE x<2002)
    INSERT INTO intents SELECT x,'synthetic_'||x,'[]','[]',NULL,'{}','text','pending','2026-01-01' FROM n;`);
    expect(() => collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' })).toThrow('catalogue exceeds');
  } finally {
    db.close();
  }
});

test('non-positive maxHistory fails before reading private data', () => {
  const db = fixture();
  try {
    for (const n of [0, -1, 1.5, Infinity, 20001])
      expect(() => collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic', maxHistory: n })).toThrow();
  } finally {
    db.close();
  }
});

test('oversized recorded match input is excluded from the examined denominator', () => {
  const db = fixture();
  try {
    db.exec('ALTER TABLE user_action_log ADD COLUMN input_summary TEXT');
    const insert = db.query(
      'INSERT INTO user_action_log(action_type,action_name,success,created_at,input_summary) VALUES(?,?,?,?,?)',
    );
    insert.run('intent_match', 'show_today', 1, '2026-03-03 00:00:00', 'что у меня сегодня');
    insert.run('intent_match', 'show_today', 1, '2026-03-03 00:00:01', 'x'.repeat(16001));
    const s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.statistics.recordedInputReplay).toMatchObject({
      fetched: 2,
      examined: 1,
      skippedOversized: 1,
      matched: 1,
      sameIntent: 1,
    });
    expect(s.statistics.recordedMatches).toBe(3);
  } finally {
    db.close();
  }
});

test('each historical phrase is assigned to its actual seed, not the array offset', () => {
  const db = fixture();
  try {
    const insert = db.query('INSERT INTO chat_history(role,content,created_at) VALUES(?,?,?)');
    for (const seed of seedIntents.slice(1)) {
      const phrase = seed.phrases[0];
      if (!phrase) throw new Error('Seed fixture requires a real example');
      insert.run('user', phrase, '2026-03-03 00:00:02');
    }
    const s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    for (const seed of seedIntents)
      expect(s.seeds.find((row) => row.name === seed.canonical_name)?.replayMatches).toBe(1);
    expect(s.statistics.replay.matched).toBe(6);
  } finally {
    db.close();
  }
});

test('examined history window excludes activity and oversized rows', () => {
  const db = fixture();
  try {
    db.query('INSERT INTO chat_history(role,content,created_at) VALUES(?,?,?)').run(
      'user',
      'x'.repeat(16001),
      '2026-03-04 00:00:00',
    );
    db.query('INSERT INTO chat_history(role,content,created_at) VALUES(?,?,?)').run(
      'user',
      '{"kind":"button"}',
      '2026-03-05 00:00:00',
    );
    const s = collectIntentSnapshot(db, seedIntents, { sourceRevision: 'synthetic' });
    expect(s.statistics.replay).toMatchObject({
      examined: 2,
      skippedActivity: 1,
      skippedOversized: 1,
      window: { first: '2026-03-03 00:00:00', last: '2026-03-03 00:00:01' },
      sampledWindow: { first: '2026-03-03 00:00:00', last: '2026-03-05 00:00:00' },
    });
  } finally {
    db.close();
  }
});
