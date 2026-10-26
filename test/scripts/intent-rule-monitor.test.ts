// The post-activation safety net: rule share, pushback after a rule answer, and the flag that says "roll back".
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MONITOR_LIMITS, monitorRuleAnswers, renderReport } from '../../scripts/intent-rule-monitor.ts';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const NOW = Date.parse('2030-03-17T12:00:00Z');
const OPTIONS = { nowMs: NOW, hours: 48, followUpMinutes: 10 };
const FIRST_USER = 5000000100;

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
});
afterEach(() => db.close());

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');

function user(id: number): number {
  db.query('INSERT OR IGNORE INTO users (telegram_id, timezone, language) VALUES (?, ?, ?)').run(id, 'UTC', 'en');
  return id;
}
function said(userId: number, text: string, atMs: number, role = 'user') {
  db.query('INSERT INTO chat_history (user_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(
    user(userId),
    role,
    text,
    stamp(atMs),
  );
}
/** One rule answer: the user's message, then the intent_match row logged in the same second. */
function ruleAnswer(userId: number, text: string, atMs: number, rule = 'basis.calendar.day') {
  said(userId, text, atMs);
  db.query(
    "INSERT INTO user_action_log (user_id, chat_id, action_type, action_name, input_summary, created_at) VALUES (?, ?, 'intent_match', ?, ?, ?)",
  ).run(user(userId), userId, rule, text, stamp(atMs));
}
const minutes = (count: number) => count * 60_000;
const ago = (ms: number) => NOW - ms;

describe('monitorRuleAnswers', () => {
  test('an empty window is not a verdict', () => {
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report).toMatchObject({
      userMessages: 0,
      ruleAnswers: 0,
      ruleShare: null,
      pushbackRate: null,
      flagged: false,
    });
  });

  test('rule share is rule answers over user messages of the window', () => {
    ruleAnswer(FIRST_USER, 'what is tomorrow', ago(minutes(120)));
    said(FIRST_USER, 'plan my week with the team', ago(minutes(90)));
    said(FIRST_USER, 'thanks', ago(minutes(80)));
    said(FIRST_USER, 'a bot reply is not a user message', ago(minutes(70)), 'assistant');
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report.userMessages).toBe(3);
    expect(report.ruleAnswers).toBe(1);
    expect(report.ruleShare).toBeCloseTo(1 / 3, 9);
  });

  test('messages and answers older than the window are ignored', () => {
    ruleAnswer(FIRST_USER, 'what is tomorrow', ago(minutes(60 * 49)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report.ruleAnswers).toBe(0);
    expect(report.userMessages).toBe(0);
  });

  test('a correction right after a rule answer counts, a new topic does not', () => {
    ruleAnswer(FIRST_USER, 'delete the standup', ago(minutes(300)), 'basis.event.delete');
    said(FIRST_USER, 'no, not that one', ago(minutes(300) - minutes(2)));
    ruleAnswer(FIRST_USER, 'what is tomorrow', ago(minutes(200)));
    said(FIRST_USER, 'book lunch with Anna on friday', ago(minutes(200) - minutes(1)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report).toMatchObject({ judgedAnswers: 2, corrections: 1, retries: 0 });
    expect(report.pushbackRate).toBe(0.5);
    expect(report.perRule.find((rule) => rule.rule === 'basis.event.delete')).toMatchObject({
      answers: 1,
      pushbacks: 1,
    });
  });

  test('the same request sent again within the window is a retry', () => {
    ruleAnswer(FIRST_USER, 'what is on tomorrow', ago(minutes(300)));
    said(FIRST_USER, 'what is on tomorrow?', ago(minutes(300) - minutes(1)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report).toMatchObject({ judgedAnswers: 1, corrections: 0, retries: 1 });
  });

  test('answering the rule own confirmation question is not pushback, even when the user re-sends the request after it', () => {
    ruleAnswer(FIRST_USER, 'delete the standup', ago(minutes(300)), 'basis.event.delete');
    said(FIRST_USER, 'Отмена', ago(minutes(300) - minutes(1)));
    said(FIRST_USER, 'delete the standup', ago(minutes(300) - minutes(2)));
    ruleAnswer(FIRST_USER + 1, 'delete the retro', ago(minutes(200)), 'basis.event.delete');
    said(FIRST_USER + 1, 'да', ago(minutes(200) - minutes(1)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report).toMatchObject({ judgedAnswers: 2, corrections: 0, retries: 0, pushbackRate: 0 });
  });

  test('a follow-up after the window, or from another user, is not pushback', () => {
    ruleAnswer(FIRST_USER, 'what is tomorrow', ago(minutes(300)));
    said(FIRST_USER, 'no', ago(minutes(300) - minutes(11)));
    said(FIRST_USER + 1, 'no', ago(minutes(300) - minutes(1)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report.corrections).toBe(0);
    expect(report.pushbackRate).toBe(0);
  });

  test('an answer whose follow-up window is still open is counted but not judged', () => {
    ruleAnswer(FIRST_USER, 'what is tomorrow', ago(minutes(3)));
    said(FIRST_USER, 'no', ago(minutes(2)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(report).toMatchObject({ ruleAnswers: 1, judgedAnswers: 0, corrections: 0, pushbackRate: null });
  });

  test('the answer own message is not its follow-up', () => {
    ruleAnswer(FIRST_USER, 'no', ago(minutes(300)));
    expect(monitorRuleAnswers(db, OPTIONS).corrections).toBe(0);
  });

  describe('the flag', () => {
    function answers(count: number, pushedBack: number) {
      for (let index = 0; index < count; index++) {
        const at = ago(minutes(30 + index * 15));
        ruleAnswer(FIRST_USER + index, 'what is tomorrow', at);
        if (index < pushedBack) said(FIRST_USER + index, 'no, wrong', at + minutes(1));
      }
    }

    test('pushback above 15% over at least 20 rule answers flags the window', () => {
      answers(20, 4);
      const report = monitorRuleAnswers(db, OPTIONS);
      expect(report.judgedAnswers).toBe(20);
      expect(report.pushbackRate).toBe(0.2);
      expect(report.flagged).toBe(true);
      expect(renderReport(report)).toContain('FLAGGED');
      expect(renderReport(report)).toContain('intent-revision.ts');
    });

    test('exactly 15% does not flag', () => {
      answers(20, 3);
      expect(monitorRuleAnswers(db, OPTIONS).flagged).toBe(false);
    });

    test('a high rate over fewer than 20 answers is not enough to judge', () => {
      answers(19, 19);
      const report = monitorRuleAnswers(db, OPTIONS);
      expect(report.pushbackRate).toBe(1);
      expect(report.flagged).toBe(false);
      expect(renderReport(report)).toContain('not enough rule answers');
    });

    test('the thresholds are the owner-set ones', () => {
      expect(MONITOR_LIMITS.flagAbove).toBe(0.15);
      expect(MONITOR_LIMITS.minAnswers).toBe(20);
    });
  });

  test('the report never carries user text', () => {
    ruleAnswer(FIRST_USER, 'distinctive-secret-phrase tomorrow', ago(minutes(300)));
    said(FIRST_USER, 'no distinctive-secret-phrase', ago(minutes(299)));
    const report = monitorRuleAnswers(db, OPTIONS);
    expect(JSON.stringify(report)).not.toContain('distinctive-secret-phrase');
    expect(renderReport(report)).not.toContain('distinctive-secret-phrase');
  });
});

describe('scripts/intent-rule-monitor.ts', () => {
  test('rejects a missing database argument with exit code 2', () => {
    const run = Bun.spawnSync([process.execPath, '--no-env-file', 'scripts/intent-rule-monitor.ts']);
    expect(run.exitCode).toBe(2);
    expect(new TextDecoder().decode(run.stderr)).toContain('--db is required');
  });
});
