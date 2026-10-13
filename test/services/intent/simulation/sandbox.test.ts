// The child process seals network and process spawning before it runs any case; tools with
// external effects are answered by the simulator instead of their handlers.
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { sandboxDecision } from '../../../../src/services/intent/simulation/sandbox.ts';

const SANDBOX = resolve(import.meta.dir, '../../../../src/services/intent/simulation/sandbox.ts');

async function runSealed(body: string): Promise<string> {
  const script = `import { sealProcess } from ${JSON.stringify(SANDBOX)}; sealProcess(); ${body}`;
  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  clearTimeout(timer);
  return out + err;
}

test('a sealed process cannot reach the network', async () => {
  const output = await runSealed(
    "try { await fetch('http://127.0.0.1:9/'); console.log('reached'); } catch (e) { console.log(String(e)); }",
  );
  expect(output).toContain('simulation_network_blocked');
  expect(output).not.toContain('reached');
});

test('a sealed process cannot spawn a helper process', async () => {
  const output = await runSealed(
    "try { Bun.spawn(['true']); console.log('spawned'); } catch (e) { console.log(String(e)); }",
  );
  expect(output).toContain('simulation_spawn_blocked');
  expect(output).not.toContain('spawned');
});

test('tools that reach other people or services are blocked, image rendering is stubbed, the rest run', () => {
  for (const tool of ['send_invitation', 'resend_invitation', 'notify_participants', 'make_call', 'share_agenda'])
    expect(sandboxDecision(tool)).toBe('blocked');
  for (const tool of ['schedule_ai_call', 'share_event', 'send_feedback', 'add_trigger'])
    expect(sandboxDecision(tool)).toBe('blocked');
  expect(sandboxDecision('render_day_image')).toBe('stubbed');
  // Local reads run: without a resolver or Google repository in the sandbox they answer from the database.
  for (const tool of ['get_events', 'create_event', 'manage_settings', 'ask_user', 'find_user'])
    expect(sandboxDecision(tool)).toBe('run');
  for (const tool of ['connect_telegram_status', 'get_google_calendar_status', 'list_google_calendars'])
    expect(sandboxDecision(tool)).toBe('run');
});
