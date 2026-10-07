/** One message, as the engine sees it after parsing Gmail's payload. */
export interface Email {
  id: string;
  /** The raw From header: "Harbor Bank <alerts@harborbank.example>". */
  from: string;
  /** Bare address, lowercased. */
  sender: string;
  senderDomain: string;
  subject: string;
  /** Gmail's own preview text. This, not the body, is what the model is shown. */
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  /** The raw List-Unsubscribe header, "" when absent. */
  listUnsubscribe: string;
  /** Gmail label ids: UNREAD, INBOX, STARRED, CATEGORY_PROMOTIONS, and our own labels. */
  labels: string[];
  /** ISO 8601. */
  date: string;
}

/**
 * What happens to a message. Production has four actions (WHITELIST, SKIP,
 * UNSUBSCRIBE, FLAG); two of them leave the mail exactly where it is, so here
 * they are one outcome with two reasons.
 */
export type Outcome = "keep" | "unsubscribe" | "flag";

/** Which layer settled it. */
export type DecidedBy = "keep_list" | "block_list" | "promotions" | "score";

export interface LayerResult {
  layer: string;
  /** 0 is clean, 1 is certainly unwanted. */
  score: number;
  reason: string;
}

export interface Decision {
  outcome: Outcome;
  decidedBy: DecidedBy;
  score: number;
  /** Score from the rules alone, before the model and the engagement dampener. */
  ruleScore: number;
  /** "asked", "cached", or why it was not asked. */
  model: "asked" | "cached" | "outside_band" | "no_answer" | "not_reached";
  layers: LayerResult[];
  reason: string;
}

/** The user's own controls. Both lists are written only by explicit user actions. */
export interface UserLists {
  keepEmails: string[];
  keepDomains: string[];
  blockDomains: string[];
}

export interface UserSettings extends UserLists {
  /** The spam appetite dial. 0.3 (Ravenous) to 0.7 (Picky). */
  spamScoreThreshold: number;
  /** Days an eaten message sits under its label before it moves to Trash. */
  autoTrashAfterDays: number;
}

export type Resolution = "clean" | "skipped" | "unsubscribe" | "blocked" | "whitelist";

/** One row per message ever decided. Mirrors production's flagged_emails. */
export interface DecisionRow {
  messageId: string;
  sender: string;
  senderDomain: string;
  subject: string;
  score: number;
  reason: string;
  status: "pending" | "resolved";
  resolution: Resolution | null;
  createdAt: string;
  resolvedAt: string | null;
  trashedAt: string | null;
  runId: string;
}

export type Mode = "clean" | "maintain";

/** Per-mailbox state carried between runs (production: gmail_connections.job_state). */
export interface AgentState {
  mode: Mode;
  consecutiveZeroBacklog: number;
  nextRunAt: string | null;
  totalRuns: number;
  /** Claude's verdicts by sender domain, so a sender is paid for once. */
  aiDomainCache: Record<string, { score: number; reason: string; ts: string }>;
}

export const initialState = (): AgentState => ({
  mode: "clean",
  consecutiveZeroBacklog: 0,
  nextRunAt: null,
  totalRuns: 0,
  aiDomainCache: {},
});
