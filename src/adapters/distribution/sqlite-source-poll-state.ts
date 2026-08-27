import { DatabaseSync } from "node:sqlite";
import type { SourcePollingRuntimeState, SourcePollingStateStorePort } from "../../domain/source-poll-state-ports.js";

interface Row { last_poll_at:string|null;next_poll_at:string|null;last_trigger:string|null;skipped_cycles:number;updated_at:string; }
function iso(value:string):string{const date=new Date(value);if(Number.isNaN(date.getTime()))throw new Error(`Invalid timestamp: ${value}`);return date.toISOString();}

/** One workspace database owns one source-poll state row shared by daemon and Control Center. */
export class SqliteSourcePollingStateStore implements SourcePollingStateStorePort {
  private readonly db:DatabaseSync;
  constructor(databasePath:string){
    this.db=new DatabaseSync(databasePath);this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_poll_state(
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
      last_poll_at TEXT,
      next_poll_at TEXT,
      last_trigger TEXT,
      skipped_cycles INTEGER NOT NULL CHECK(skipped_cycles>=0),
      updated_at TEXT NOT NULL
    );`);
  }
  get():SourcePollingRuntimeState|null{
    const row=this.db.prepare("SELECT last_poll_at,next_poll_at,last_trigger,skipped_cycles,updated_at FROM source_poll_state WHERE singleton_id=1").get() as Row|undefined;
    if(!row)return null;
    const state:SourcePollingRuntimeState={skippedCycles:row.skipped_cycles,updatedAt:row.updated_at};
    if(row.last_poll_at)state.lastPollAt=row.last_poll_at;
    if(row.next_poll_at)state.nextPollAt=row.next_poll_at;
    if(row.last_trigger)state.lastTrigger=row.last_trigger as NonNullable<SourcePollingRuntimeState["lastTrigger"]>;
    return state;
  }
  put(state:SourcePollingRuntimeState):SourcePollingRuntimeState{
    const normalized:SourcePollingRuntimeState={...state,updatedAt:iso(state.updatedAt),...(state.lastPollAt?{lastPollAt:iso(state.lastPollAt)}:{}),...(state.nextPollAt?{nextPollAt:iso(state.nextPollAt)}:{})};
    this.db.prepare(`INSERT INTO source_poll_state(singleton_id,last_poll_at,next_poll_at,last_trigger,skipped_cycles,updated_at) VALUES(1,?,?,?,?,?)
      ON CONFLICT(singleton_id) DO UPDATE SET last_poll_at=excluded.last_poll_at,next_poll_at=excluded.next_poll_at,last_trigger=excluded.last_trigger,skipped_cycles=excluded.skipped_cycles,updated_at=excluded.updated_at`)
      .run(normalized.lastPollAt??null,normalized.nextPollAt??null,normalized.lastTrigger??null,normalized.skippedCycles,normalized.updatedAt);
    return normalized;
  }
  close():void{this.db.close();}
}
