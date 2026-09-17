import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const script = readFileSync(join(ROOT, 'scripts/deploy-local-fallback.sh'), 'utf8');

function position(fragment: string): number {
  const index = script.indexOf(fragment);
  if (index < 0) throw new Error(`deploy fallback is missing: ${fragment}`);
  return index;
}

describe('local deploy fallback contract', () => {
  test('deploys an exact git commit archive instead of the working tree', () => {
    expect(script).toMatch(/git rev-parse "\$\{REF\}\^\{commit\}"/);
    expect(script).toContain('git archive "$SHA"');
    expect(script).not.toContain('rsync');
  });

  test('builds and tags the exact revision while retaining a rollback image', () => {
    expect(script).toContain('-t "$IMAGE:$SHA"');
    expect(script).toContain('docker tag "$IMAGE:$SHA" "$IMAGE:latest"');
    expect(script).toContain('rollback-$STAMP');
    expect(script).toContain('org.opencontainers.image.revision=$SHA');
  });

  test('backs up before restart and reapplies runtime ownership', () => {
    const backup = position('"$DEPLOY_PATH/scripts/backup-db.sh"');
    const prepare = position('"$DEPLOY_PATH/scripts/prepare-runtime-dirs.sh" "$DEPLOY_PATH"');
    const latestTag = position('docker tag "$IMAGE:$SHA" "$IMAGE:latest"');
    const restart = position('docker compose up -d --no-deps --force-recreate bot');
    expect(backup).toBeLessThan(latestTag);
    expect(prepare).toBeLessThan(latestTag);
    expect(latestTag).toBeLessThan(restart);
  });

  test('verifies the running image and both public health contracts', () => {
    expect(script).toContain('ACTUAL_IMAGE_ID="$(docker inspect hypercal-bot');
    expect(script).toContain('https://hypercal.invntrm.ru/health');
    expect(script).toContain('https://hypercal.invntrm.ru/ready');
    expect(script).toContain('ok|"ok (unverified)"|"ai chain down"');
  });

  test('does not use broad prune commands on the shared server', () => {
    expect(script).not.toContain('docker system prune');
    expect(script).not.toContain('docker image prune');
  });
});
