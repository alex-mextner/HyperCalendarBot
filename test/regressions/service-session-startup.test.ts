import { expect, test } from 'bun:test';

test('service bridges check account identity without interactive login', async () => {
  const p = Bun.spawn(['python3', '-B', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_service*.py'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
