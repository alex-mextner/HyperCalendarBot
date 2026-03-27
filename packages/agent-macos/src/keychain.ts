import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function tokenPath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'token.json');
}

export async function saveJwt(jwt: string): Promise<void> {
  writeFileSync(tokenPath(), JSON.stringify({ jwt }), 'utf8');
}

export async function loadJwt(): Promise<string | null> {
  try {
    const raw = readFileSync(tokenPath(), 'utf8');
    const parsed = JSON.parse(raw) as { jwt?: unknown };
    return typeof parsed.jwt === 'string' ? parsed.jwt : null;
  } catch {
    return null;
  }
}

export async function clearJwt(): Promise<void> {
  try {
    unlinkSync(tokenPath());
  } catch {
    // file didn't exist
  }
}
