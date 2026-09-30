import { expect, test } from 'bun:test';

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
