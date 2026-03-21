import keytar from 'keytar';

const SERVICE = 'hyperbot-agent';
const ACCOUNT = 'jwt';

export async function saveJwt(jwt: string): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT, jwt);
}

export async function loadJwt(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT);
}

export async function clearJwt(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT);
}
