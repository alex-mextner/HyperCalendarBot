import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const script = readFileSync(join(ROOT, 'scripts/deploy-local-fallback.sh'), 'utf8');
const remote = readFileSync(join(ROOT, 'scripts/deploy-prebuilt-image.sh'), 'utf8');

describe('local deploy transport contracts (behavior exercised in Python harness)', () => {
  test('local Unix daemon builds exact archive as linux/amd64', () => {
    expect(script).toContain('git archive "$SHA"');
    expect(script).toContain('docker_local build --platform linux/amd64');
    expect(script).toContain('"$endpoint" == unix://*');
    expect(remote).not.toMatch(/docker build|bun test|bun install/);
  });
  test('source, artifact and container have explicit identity checks', () => {
    expect(script).toContain('Ref is not current origin/main');
    expect(remote).toContain('Archive checksum mismatch');
    expect(remote).toContain('Loaded config identity mismatch');
    expect(remote).toContain('"$REVISION" == "$SHA"');
  });
  test('only unchanged migration code uses generic image rollback', () => {
    expect(remote).toContain('"$old_schema" == "$new_schema"');
    expect(remote).toContain('never restoring an older user database');
    expect(remote.indexOf('Schema-changing release')).toBeLessThan(remote.indexOf('scripts/backup-db.sh"'));
  });
  test('readiness must be healthy, not just routed to a bot', () => {
    expect(remote).toContain('"$HEALTH" == ok');
    expect(remote).toContain('ok|"ok (unverified)")');
    expect(remote).not.toContain('"ai chain down"');
    expect(remote).toContain('--no-build --pull never');
  });
  test('shared server and personal registry credentials are not modified', () => {
    expect(script).not.toMatch(/docker (system|image) prune|docker login|docker logout|pm2 delete/);
    expect(remote).not.toContain('caddy reload');
    expect(remote).toContain('data=preserved');
  });
});
