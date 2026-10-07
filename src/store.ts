/**
 * Where decisions and runs are written. The in-memory store is for tests and
 * the demo; schema/001_inbox.sql is the same shape in Postgres, with row level
 * security.
 */
import type { DecisionRow } from "./types.ts";

export interface JobRun {
  id: string;
  mode: "clean" | "maintain";
  startedAt: string;
  backlog: number;
  processed: number;
  unsubscribed: number;
  flagged: number;
  kept: number;
  errors: number;
}

export interface Store {
  /** Insert or replace by message id: a message has one decision row, however often it is seen. */
  upsert(row: DecisionRow): void;
  get(messageId: string): DecisionRow | undefined;
  rows(): DecisionRow[];
  update(messageId: string, patch: Partial<DecisionRow>): void;
  addRun(run: JobRun): void;
}

export class MemoryStore implements Store {
  private byMessage = new Map<string, DecisionRow>();
  readonly runs: JobRun[] = [];

  upsert(row: DecisionRow) {
    this.byMessage.set(row.messageId, { ...row });
  }
  get(messageId: string) {
    return this.byMessage.get(messageId);
  }
  rows() {
    return [...this.byMessage.values()];
  }
  update(messageId: string, patch: Partial<DecisionRow>) {
    const row = this.byMessage.get(messageId);
    if (row) Object.assign(row, patch);
  }
  addRun(run: JobRun) {
    this.runs.push(run);
  }
}
