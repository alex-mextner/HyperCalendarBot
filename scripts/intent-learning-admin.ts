// Operator CLI for the intent-learning registry. It runs on the host that owns the database files
// and calls the same service functions as the HTTP route; it never talks to a worker.
//
//   bun scripts/intent-learning-admin.ts --db data/calendar.db --admin-id <BOT_ADMIN_ID> status
//   ... list [status] | show <id> | propose <proposal.json> | approve <id> <hash> | reject <id> [reason]
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { IntentLearningError } from '../src/services/intent-learning/context.ts';
import { ManualProposalSchema } from '../src/services/intent-learning/schemas.ts';
import { IntentLearningService } from '../src/services/intent-learning/service.ts';
import { jsonCodec } from '../src/utils/json-codec.ts';

const ManualProposalJson = jsonCodec(ManualProposalSchema);

function usage(): never {
  console.error(
    'Usage: intent-learning-admin --db <calendar.db> --admin-id <BOT_ADMIN_ID> ' +
      '<status | list [status] | show <id> | propose <file.json> | approve <id> <hash> | reject <id> [reason]>',
  );
  process.exit(2);
}

function positiveId(value: string | undefined): number {
  const id = Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(id) || id <= 0) usage();
  return id;
}

async function run(service: IntentLearningService, actorId: number, command: string, args: string[]) {
  const actor = { kind: 'cli' as const, userId: actorId };
  switch (command) {
    case 'status':
      return service.status();
    case 'list':
      return service.listProposals(args[0]);
    case 'show':
      return service.getProposal(positiveId(args[0]));
    case 'propose': {
      if (!args[0]) usage();
      const parsed = ManualProposalJson.safeParse(await Bun.file(args[0]).text());
      if (!parsed.success) throw new Error(`Invalid proposal file: ${parsed.error.message}`);
      return service.createManualProposal(parsed.data, actor);
    }
    case 'approve':
      if (!args[1]) usage();
      return service.approve({ proposalId: positiveId(args[0]), expectedHash: args[1], actor });
    case 'reject':
      service.reject({ proposalId: positiveId(args[0]), actor, reason: args.slice(1).join(' ') });
      return { status: 'rejected' };
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { db: { type: 'string' }, 'admin-id': { type: 'string' } },
    allowPositionals: true,
  });
  if (!values.db || !values['admin-id'] || positionals.length === 0) usage();
  const adminId = positiveId(values['admin-id']);
  const mainDb = new Database(values.db, { create: false });
  const service = IntentLearningService.open({ mainDb, adminId });
  try {
    const result = await run(service, adminId, positionals[0]!, positionals.slice(1));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (!(err instanceof IntentLearningError)) throw err;
    console.error(JSON.stringify({ error: err.code, message: err.message, details: err.details }, null, 2));
    process.exitCode = 1;
  } finally {
    service.close();
    mainDb.close();
  }
}

await main();
