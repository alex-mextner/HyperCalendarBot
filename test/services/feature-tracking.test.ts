import { describe, expect, mock, test } from 'bun:test';
import type { FeatureUsageRepository } from '../../src/database/repositories/feature-usage.repository.ts';
import { callbackPrefix, trackFeatureUsage } from '../../src/services/feature-tracking.ts';

function makeRepo(overrides: Partial<FeatureUsageRepository> = {}): FeatureUsageRepository {
  return {
    record: mock(() => {}),
    getForUser: mock(() => []),
    getOne: mock(() => null),
    getStaleFeatures: mock(() => []),
    ...overrides,
  } as unknown as FeatureUsageRepository;
}

describe('trackFeatureUsage', () => {
  test('records command feature', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'command', 'today');
    expect(repo.record).toHaveBeenCalledWith(42, 'events_create');
  });

  test('records callback feature', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'callback', 'mn');
    expect(repo.record).toHaveBeenCalledWith(42, 'month_view');
  });

  test('records scene feature', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'scene', 'add-event');
    expect(repo.record).toHaveBeenCalledWith(42, 'events_create');
  });

  test('records action feature', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'action', 'voice_message');
    expect(repo.record).toHaveBeenCalledWith(42, 'events_create');
  });

  test('ignores unknown command', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'command', 'unknown_cmd');
    expect(repo.record).not.toHaveBeenCalled();
  });

  test('ignores unknown callback prefix', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'callback', 'zzz');
    expect(repo.record).not.toHaveBeenCalled();
  });

  test('does nothing when repo is undefined', () => {
    // Should not throw
    trackFeatureUsage(undefined, 42, 'command', 'today');
  });

  test('swallows record errors silently', () => {
    const repo = makeRepo({
      record: mock(() => {
        throw new Error('DB error');
      }),
    } as Partial<FeatureUsageRepository>);
    // Should not throw
    trackFeatureUsage(repo, 42, 'command', 'today');
    expect(repo.record).toHaveBeenCalled();
  });

  test('all COMMAND_FEATURE_MAP entries produce valid calls', () => {
    const commands = [
      'today',
      'tomorrow',
      'week',
      'month',
      'add',
      'edit',
      'delete',
      'search',
      'free',
      'settings',
      'import',
      'holidays',
      'birthdays',
      'invite',
      'invitations',
      'share',
      'connect_google',
      'disconnect_google',
      'google_status',
      'log',
      'contacts',
    ];
    for (const cmd of commands) {
      const repo = makeRepo();
      trackFeatureUsage(repo, 42, 'command', cmd);
      expect(repo.record).toHaveBeenCalledTimes(1);
    }
  });

  test('all SCENE_FEATURE_MAP entries produce valid calls', () => {
    const scenes = ['add-event', 'edit-value', 'import', 'timezone'];
    for (const scene of scenes) {
      const repo = makeRepo();
      trackFeatureUsage(repo, 42, 'scene', scene);
      expect(repo.record).toHaveBeenCalledTimes(1);
    }
  });

  test('all ACTION_FEATURE_MAP entries produce valid calls', () => {
    const actions = ['voice_message', 'ics_file', 'geolocation'];
    for (const action of actions) {
      const repo = makeRepo();
      trackFeatureUsage(repo, 42, 'action', action);
      expect(repo.record).toHaveBeenCalledTimes(1);
    }
  });

  test('ignores unknown scene', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'scene', 'nonexistent');
    expect(repo.record).not.toHaveBeenCalled();
  });

  test('ignores unknown action', () => {
    const repo = makeRepo();
    trackFeatureUsage(repo, 42, 'action', 'nonexistent');
    expect(repo.record).not.toHaveBeenCalled();
  });

  test('all CALLBACK_FEATURE_MAP entries produce valid calls', () => {
    const prefixes = [
      'ev',
      'ee',
      'ef',
      'ed',
      'edc',
      'er',
      'erd',
      'erm',
      'mn',
      'nf',
      'hl',
      'gc',
      'imd',
      'imw',
      'inv',
      'st',
      'sec',
    ];
    for (const prefix of prefixes) {
      const repo = makeRepo();
      trackFeatureUsage(repo, 42, 'callback', prefix);
      expect(repo.record).toHaveBeenCalledTimes(1);
    }
  });
});

describe('callbackPrefix', () => {
  test('extracts prefix before colon', () => {
    expect(callbackPrefix('ev:123')).toBe('ev');
  });

  test('returns full string when no colon', () => {
    expect(callbackPrefix('ev')).toBe('ev');
  });

  test('handles nested colons', () => {
    expect(callbackPrefix('sec:accept:42')).toBe('sec');
  });

  test('handles empty prefix', () => {
    expect(callbackPrefix(':data')).toBe('');
  });
});
