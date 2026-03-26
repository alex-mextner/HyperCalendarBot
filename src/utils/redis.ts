export function parseRedisUrl(url: string): { host: string; port: number; username?: string; password?: string } {
  const parsed = new URL(url);
  const result: { host: string; port: number; username?: string; password?: string } = {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port) || 6379,
  };
  if (parsed.password) result.password = decodeURIComponent(parsed.password);
  if (parsed.username) result.username = decodeURIComponent(parsed.username);
  return result;
}
