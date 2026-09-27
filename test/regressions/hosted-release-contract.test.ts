import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const stepSchema = z
  .object({
    name: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const workflow = z
  .object({
    jobs: z.object({
      build: z.object({ needs: z.literal('test'), steps: z.array(stepSchema) }),
      deploy: z.object({ needs: z.literal('build'), steps: z.array(stepSchema) }),
    }),
  })
  .parse(Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../.github/workflows/deploy.yml'), 'utf8')));

test('hosted image labels bind the tested source revision', () => {
  const build = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression in the workflow contract
  expect(build?.with?.labels).toContain('org.opencontainers.image.revision=${{ github.sha }}');
});

test('hosted deployment uses the same checksum-verified rollback-capable activator', () => {
  const prepare = workflow.jobs.deploy.steps.find((step) => step.name === 'Prepare exact release artifact');
  expect(prepare?.run).toContain('release-artifact.py');
  expect(prepare?.run).toContain('GITHUB_OUTPUT');
  const activate = workflow.jobs.deploy.steps.find((step) => step.name === 'Activate verified prebuilt release');
  expect(activate?.with?.script).toContain('scripts/deploy-prebuilt-image.sh');
  expect(activate?.with?.script).toContain('"$ARCHIVE_SUM" "$CONFIG_ID"');
});

test('hosted deployment never follows latest or changes unrelated shared services', () => {
  const text = JSON.stringify(workflow.jobs.deploy);
  expect(text).not.toContain(':latest');
  expect(text).not.toContain('docker image prune');
  expect(text).not.toContain('caddy reload');
  expect(text).toContain('Release still targets main');
});
