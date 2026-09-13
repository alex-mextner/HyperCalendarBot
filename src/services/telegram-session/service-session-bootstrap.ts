// Gates shared MTProto startup on a dedicated service file and a matching identity probe.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isExpectedServiceSession } from './service-session-identity.ts';

interface ServiceConfig {
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  MTPROTO_SERVICE_USER_ID?: number;
}

interface SessionProbe {
  sessionExists: () => boolean;
  probe: () => Promise<{ stdout: string; exitCode: number }>;
}

export function bootstrapServiceSession(
  config: ServiceConfig,
  dependencies: { dataDirectory: string; probe: SessionProbe['probe'] },
): Promise<boolean> {
  return decideServiceSession(config, {
    sessionExists: () => existsSync(join(dependencies.dataDirectory, 'voice_caller.session')),
    probe: dependencies.probe,
  });
}

export async function decideServiceSession(config: ServiceConfig, dependencies: SessionProbe): Promise<boolean> {
  const expected = config.MTPROTO_SERVICE_USER_ID;
  if (
    !config.MTPROTO_API_ID ||
    !config.MTPROTO_API_HASH ||
    expected === undefined ||
    !Number.isSafeInteger(expected) ||
    expected <= 0
  )
    return false;
  if (!dependencies.sessionExists()) return false;
  try {
    const { stdout, exitCode } = await dependencies.probe();
    return isExpectedServiceSession(stdout, exitCode, expected);
  } catch {
    return false;
  }
}
