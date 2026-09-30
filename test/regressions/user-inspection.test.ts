import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { executeTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';

function setup(): { db: Database; ctx: AgentContext } {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE contacts(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,username TEXT,telegram_id INTEGER,preferred_name TEXT,created_at TEXT DEFAULT (datetime('now')))",
  );
  const contacts = new ContactRepository(db);
  contacts.add(10, 'Alex', 'old', 5000000001, 'Sasha');
  return {
    db,
    ctx: {
      user: { telegram_id: 10, language: 'en' },
      chatId: 10,
      isGroup: false,
      messageText: 'Who is Alex?',
      contactRepo: contacts,
    } as unknown as AgentContext,
  };
}
test('user inspection reports the saved contact by ID without rewriting it', async () => {
  const { db, ctx } = setup();
  try {
    const result = await executeTool(ctx, 'get_user_info', { telegram_id: 5000000001 });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ telegram_id: 5000000001, username: 'old', preferred_name: 'Sasha' });
    expect(ctx.contactRepo!.findByTelegramId(10, 5000000001)).toMatchObject({
      username: 'old',
      preferred_name: 'Sasha',
    });
  } finally {
    db.close();
  }
});
test('user inspection cannot enumerate strangers or disclose contacts to groups', async () => {
  const { db, ctx } = setup();
  try {
    expect((await executeTool(ctx, 'get_user_info', { telegram_id: 5000000002 })).success).toBe(false);
    ctx.isGroup = true;
    expect((await executeTool(ctx, 'get_user_info', { telegram_id: 5000000001 })).success).toBe(false);
  } finally {
    db.close();
  }
});
