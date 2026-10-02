import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const script = readFileSync(join(ROOT, 'scripts/deploy-local-fallback.sh'), 'utf8');

describe('local deploy fallback contract', () => {
  test('is callable only through a matching gh ship merge guard', () => {
    expect(script).toContain('HYPERCAL_GH_SHIP_GUARD_FILE');
    expect(script).toContain('HYPERCAL_SHIP_MERGE_SHA');
    expect(script).toContain('local fallback must be invoked by gh ship');
    expect(script).toContain('gh ship guard does not match merge SHA');
  });

  test('deploys exact current origin/main archive rather than working tree', () => {
    expect(script).toContain('git fetch origin main');
    expect(script).toContain("git rev-parse 'origin/main^{commit}'");
    expect(script).toContain('git archive "$SHA"');
    expect(script).not.toContain('rsync');
  });

  test('builds immutable amd64 image locally and transfers a checksum-verified archive', () => {
    expect(script).toContain('build --platform linux/amd64');
    expect(script).toContain('org.opencontainers.image.revision=$SHA');
    expect(script).toContain('scripts/runtime-smoke.ts');
    expect(script).toContain('save "$IMAGE"');
    expect(script).toContain('sha256sum');
    expect(script).toContain('image transfer checksum mismatch');
    expect(script).not.toContain('docker build');
    expect(script).not.toContain('docker pull');
    expect(script).not.toContain('docker login');
  });

  test('reuses one transactional remote stage path shared with hosted CI', () => {
    expect(script).toContain('scripts/stage-release.sh');
    expect(script).toContain('scripts/prepare-runtime-dirs.sh');
    expect(script).toContain('DEPLOY_IMAGE_PRELOADED=1');
    expect(script).toContain('bash -s --');
  });

  test('validates deploy host/path/repository before composing remote command', () => {
    expect(script).toContain('invalid deploy host');
    expect(script).toContain('invalid deploy directory');
    expect(script).toContain('invalid image repository');
  });

  test('verifies both public health contracts after remote transaction', () => {
    expect(script).toContain('https://hypercal.invntrm.ru/health');
    expect(script).toContain('https://hypercal.invntrm.ru/ready');
    expect(script).toContain('[[ "$health" == ok && "$ready" =~ ^ok ]]');
  });

  test('does not use broad prune commands on the shared server', () => {
    expect(script).not.toContain('docker system prune');
    expect(script).not.toContain('docker image prune');
  });
});
