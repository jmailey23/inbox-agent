/**
 * The part of Gmail the agent touches, as an interface.
 *
 * Every call here maps to one Gmail API call in production (messages.list with
 * a query, messages.get, messages.modify, messages.trash). There is no method
 * for permanent deletion, because the agent never needs one: the most it does
 * is archive under a label, and later move to Trash, where Gmail keeps mail
 * for another 30 days.
 *
 * FakeMailbox implements the same queries over an in-memory list, so the
 * whole agent runs and tests with no account and no network.
 */
import type { Email } from "./types.ts";

/** Every message the agent has looked at carries this, so nothing is scanned twice. */
export const SCANNED_LABEL = "Gary-Scanned";
/** Eaten mail is archived under this label. Moving it back to the inbox undoes Gary. */
export const EATEN_LABEL = "Gary-Unsubscribed";

/** The production query, for reference. FakeMailbox applies the same filter. */
export const BACKLOG_QUERY = `is:unread -in:trash -in:spam -in:sent -in:drafts -label:${EATEN_LABEL} -label:${SCANNED_LABEL}`;

export interface Mailbox {
  /** How many messages match BACKLOG_QUERY. */
  countBacklog(): Promise<number>;
  /** The oldest n of the backlog, oldest first. Gmail lists newest first, so this pages to the end. */
  oldestBacklog(n: number): Promise<string[]>;
  /** The newest n of the backlog, newest first. */
  newestBacklog(n: number): Promise<string[]>;
  get(id: string): Promise<Email>;
  /** from:sender newer_than:7d */
  countFromSender(sender: string, days: number): Promise<number>;
  /** Senders with at least minReads read messages in the last `days` days. */
  engagedSenders(days: number, minReads: number): Promise<Set<string>>;
  modify(id: string, add: string[], remove?: string[]): Promise<void>;
  /** Recoverable: Gmail keeps Trash for 30 days. */
  trash(id: string): Promise<void>;
}

const DAY = 86_400_000;

export class FakeMailbox implements Mailbox {
  private messages = new Map<string, Email>();

  constructor(
    seed: Email[] = [],
    private now: () => Date = () => new Date(),
  ) {
    seed.forEach((m) => this.deliver(m));
  }

  deliver(m: Email) {
    this.messages.set(m.id, { ...m, labels: [...m.labels] });
  }

  /** A snapshot, for the demo and tests. */
  peek(id: string): Email {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    return { ...m, labels: [...m.labels] };
  }

  all(): Email[] {
    return [...this.messages.values()].map((m) => this.peek(m.id));
  }

  private backlog(): Email[] {
    const excluded = ["TRASH", "SPAM", "SENT", "DRAFT", EATEN_LABEL, SCANNED_LABEL];
    return [...this.messages.values()]
      .filter((m) => m.labels.includes("UNREAD") && !m.labels.some((l) => excluded.includes(l)))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)); // newest first, as Gmail lists
  }

  private recent(days: number) {
    const since = this.now().getTime() - days * DAY;
    return [...this.messages.values()].filter((m) => Date.parse(m.date) >= since);
  }

  async countBacklog() {
    return this.backlog().length;
  }

  async oldestBacklog(n: number) {
    return this.backlog().slice(-n).reverse().map((m) => m.id);
  }

  async newestBacklog(n: number) {
    return this.backlog().slice(0, n).map((m) => m.id);
  }

  async get(id: string) {
    return this.peek(id);
  }

  async countFromSender(sender: string, days: number) {
    return this.recent(days).filter((m) => m.sender === sender.toLowerCase()).length;
  }

  async engagedSenders(days: number, minReads: number) {
    const reads = new Map<string, number>();
    for (const m of this.recent(days)) {
      if (m.labels.includes("UNREAD") || m.labels.some((l) => ["TRASH", "SPAM", "SENT", "DRAFT"].includes(l))) continue;
      reads.set(m.sender, (reads.get(m.sender) ?? 0) + 1);
    }
    return new Set([...reads].filter(([, n]) => n >= minReads).map(([s]) => s));
  }

  async modify(id: string, add: string[], remove: string[] = []) {
    const m = this.messages.get(id);
    if (!m) throw new Error(`404: message ${id} not found`);
    m.labels = [...new Set([...m.labels.filter((l) => !remove.includes(l)), ...add])];
  }

  async trash(id: string) {
    await this.modify(id, ["TRASH"], ["INBOX"]);
  }
}
