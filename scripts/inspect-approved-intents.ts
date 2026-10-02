
import { Database } from 'bun:sqlite';
const db = new Database('data/calendar.db', { readonly: true });
const rows = db.query("SELECT canonical_name, workflow, format FROM intents WHERE canonical_name IN ('create_event_today_at_time','create_meeting_on_date_unambiguous','update_event_time')").all();
console.log(JSON.stringify(rows, null, 2));
