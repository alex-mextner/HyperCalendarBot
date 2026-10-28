// Contract of the stage compose file's process bound (#885). Docker Compose v5 refuses a service that sets
// `pids_limit` while `deploy.resources.limits` exists without a matching `pids` ("can't set distinct values on
// 'pids_limit' and 'deploy.resources.limits.pids'"), which ended every per-PR Stage QA run in infra-error.
// The file is parsed, not grepped: both keys must be present and equal.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const ROOT = resolve(import.meta.dir, '../..');
const STAGE_PIDS_BOUND = 512;

const service = z.looseObject({
  pids_limit: z.number().optional(),
  deploy: z
    .looseObject({
      resources: z.looseObject({ limits: z.looseObject({ pids: z.number().optional() }).optional() }).optional(),
    })
    .optional(),
});
const composeFile = z.looseObject({ services: z.record(z.string(), service) });

describe('docker-compose.stage.yml process bound', () => {
  const services = composeFile.parse(
    Bun.YAML.parse(readFileSync(resolve(ROOT, 'docker-compose.stage.yml'), 'utf8')),
  ).services;

  test('no service sets pids_limit and deploy.resources.limits.pids to different values (Compose v5 rule)', () => {
    for (const [name, definition] of Object.entries(services)) {
      const limits = definition.deploy?.resources?.limits;
      if (definition.pids_limit === undefined && limits?.pids === undefined) continue;
      expect(limits?.pids, `service ${name}`).toBe(definition.pids_limit);
    }
  });

  test('the stage bot declares the canonical bound in both keys', () => {
    const bot = services['bot-stage'];
    expect(bot?.pids_limit).toBe(STAGE_PIDS_BOUND);
    expect(bot?.deploy?.resources?.limits?.pids).toBe(STAGE_PIDS_BOUND);
  });
});
