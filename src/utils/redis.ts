export function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  const connection: { host: string; port: number; password?: string } = {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port) || 6379,
  };
  if (parsed.password) {
    connection.password = decodeURIComponent(parsed.password);
  }
  return connection;
}
