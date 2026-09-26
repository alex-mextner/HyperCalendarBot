import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const pins = (path: string, pattern: RegExp) => [...read(path).matchAll(pattern)].map((match) => match[1]);

test('CI, both images, the release gate and @types/bun pin the same Bun version', () => {
  const found = {
    'deploy.yml': pins('.github/workflows/deploy.yml', /bun-version: (\S+)/g),
    'dependency-review.yml': pins('.github/workflows/dependency-review.yml', /bun-version: (\S+)/g),
    Dockerfile: pins('Dockerfile', /^ARG BUN_VERSION=(\S+)$/gm),
    'ci.Dockerfile': pins('.github/ci.Dockerfile', /^ARG BUN_VERSION=(\S+)$/gm),
    'deploy-local-fallback.sh': pins('scripts/deploy-local-fallback.sh', /--version\)" == (\S+) \]\]/g),
    '@types/bun': [JSON.parse(read('package.json')).devDependencies['@types/bun']],
  };
  const version = found['deploy.yml'][0];
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  for (const [source, versions] of Object.entries(found)) {
    expect({ source, versions }).toEqual({ source, versions: [version] });
  }
});
