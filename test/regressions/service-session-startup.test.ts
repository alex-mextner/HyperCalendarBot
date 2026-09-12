import { expect, test } from 'bun:test';

test('startup never recovers service identity from the end-user session pool', async () => {
  const source = await Bun.file(new URL('../../src/index.ts', import.meta.url)).text();
  expect(source).not.toContain('async function recoverSessionFromDb');
  expect(source).not.toContain('sessionRepo.getMostRecentActive()');
});
test('service session health checks cannot start interactive authorization', async () => {
  const source = await Bun.file(new URL('../../scripts/check-session.py', import.meta.url)).text();
  expect(source).not.toContain('await app.start()');
});

test('service bridges check account identity without interactive login', async () => {
  for (const name of ['send-message', 'resolve-username', 'fetch-birthdays', 'voice-call-bridge']) {
    const source = await Bun.file(new URL(`../../scripts/${name}.py`, import.meta.url)).text();
    expect(source).toContain('await start_service_session(app)');
    expect(source).not.toContain('await app.start()');
  }
  const p = Bun.spawn(
    ['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_service_identity.py'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect({ out, err, code }).toMatchObject({ code: 0 });
});

// Parse every production bridge, not only the ones imported by unit-test mocks.
test('all production Python bridges are syntactically valid', async () => {
  const proc = Bun.spawn(
    [
      'python3',
      '-c',
      "import ast,pathlib; [ast.parse(p.read_text(),filename=str(p)) for p in pathlib.Path('scripts').glob('*.py')]",
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const error = await new Response(proc.stderr).text();
  expect({ code: await proc.exited, error }).toEqual({ code: 0, error: '' });
});
