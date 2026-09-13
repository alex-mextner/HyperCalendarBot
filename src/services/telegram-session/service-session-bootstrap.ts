// Decides whether shared MTProto capabilities may use the designated service session.
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

export async function bootstrapServiceSession(config: ServiceConfig, dependencies: SessionProbe): Promise<boolean> {
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
