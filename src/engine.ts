/**
 * One scheduled run for one mailbox.
 *
 * Two modes:
 *
 *   Deep Clean   the first job: work through the unread backlog, oldest
 *                first, 100 at a time, every 30 minutes, until none is left
 *   Maintain     after that: newest first, 25 at a time, every 2 hours
 *
 * Oldest first is deliberate. Gmail lists newest first, so a naive loop eats
 * this week's mail and never reaches the years of backlog the user signed up
 * to get rid of. When the backlog reaches zero the mode flips; a burst of
 * spam or a pile up after a vacation flips it back.
 *
 * Every message processed is labeled Gary-Scanned, and the backlog query
 * excludes that label, so a crashed or overlapping run can repeat itself
 * without deciding anything twice.
 *
 * Maintain runs also do the slow housekeeping: a flag nobody reviewed in 30
 * days that leaned toward spam is resolved as a Block, and mail that has sat
 * under Gary-Unsubscribed for 30 days moves to Trash.
 */
import { randomUUID } from "node:crypto";
import { thresholds } from "./appetite.ts";
import type { Classifier } from "./classifier.ts";
import { Detector } from "./detector.ts";
import { EATEN_LABEL, SCANNED_LABEL, type Mailbox } from "./mailbox.ts";
import type { Store } from "./store.ts";
import type { Unsubscriber } from "./unsubscribe.ts";
import type { AgentState, Decision, DecisionRow, Email, Mode, UserSettings } from "./types.ts";

export const MODES = {
  clean: { batch: 100, maxUnsubscribes: 50, intervalMinutes: 30, order: "oldest first" },
  maintain: { batch: 25, maxUnsubscribes: 25, intervalMinutes: 120, order: "newest first" },
} as const;

/** With nothing to do, the interval doubles each run, up to this. */
export const MAX_INTERVAL_MINUTES = 240;
/** Maintain flips back to Deep Clean on either of these. */
export const BACK_TO_CLEAN = { unsubscribes: 10, backlog: 100 };
export const PENDING_GRACE_DAYS = 30;
/** Bounded so one run never spends a mailbox's API quota on housekeeping. */
export const HOUSEKEEPING_BATCH = 200;

const DAY = 86_400_000;

export interface EngineDeps {
  mailbox: Mailbox;
  store: Store;
  classifier: Classifier;
  unsubscriber: Unsubscriber;
  settings: UserSettings;
  now: () => Date;
}

export interface Handled {
  email: Email;
  decision: Decision;
  /** What actually happened in the mailbox. */
  did: "kept" | "eaten" | "flagged" | "left (unsubscribe failed)";
}

export interface RunReport {
  runId: string;
  mode: Mode;
  backlog: number;
  handled: Handled[];
  stoppedAtCap: boolean;
  errors: number;
  staleBlocked: string[];
  trashed: string[];
  state: AgentState;
}

export async function runOnce(deps: EngineDeps, state: AgentState): Promise<RunReport> {
  const { mailbox, store, unsubscriber, settings, now } = deps;
  const runId = randomUUID();
  const mode = state.mode;
  const plan = MODES[mode];

  const detector = new Detector(settings, deps.classifier, now);
  detector.loadCache(state.aiDomainCache);

  const backlog = await mailbox.countBacklog();
  const ids = mode === "clean" ? await mailbox.oldestBacklog(plan.batch) : await mailbox.newestBacklog(plan.batch);
  const engaged = await mailbox.engagedSenders(90, 2);
  const weekCounts = new Map<string, number>();

  const handled: Handled[] = [];
  let unsubscribed = 0;
  let errors = 0;
  let stoppedAtCap = false;

  for (const id of ids) {
    try {
      const email = await mailbox.get(id);
      if (!weekCounts.has(email.sender)) weekCounts.set(email.sender, await mailbox.countFromSender(email.sender, 7));
      const decision = await detector.analyze(email, {
        sentLastWeek: weekCounts.get(email.sender)!,
        engaged: engaged.has(email.sender),
      });
      const row = (status: DecisionRow["status"], resolution: DecisionRow["resolution"]): DecisionRow => ({
        messageId: email.id,
        sender: email.sender,
        senderDomain: email.senderDomain,
        subject: email.subject,
        score: Math.round(decision.score * 1000) / 1000,
        reason: decision.reason.slice(0, 500),
        status,
        resolution,
        createdAt: now().toISOString(),
        resolvedAt: status === "resolved" ? now().toISOString() : null,
        trashedAt: null,
        runId,
      });

      if (decision.outcome === "keep") {
        store.upsert(row("resolved", decision.decidedBy === "keep_list" ? "clean" : "skipped"));
        handled.push({ email, decision, did: "kept" });
      } else if (decision.outcome === "flag") {
        // Unsure: nothing happens to the mail. It waits in the user's queue.
        store.upsert(row("pending", null));
        handled.push({ email, decision, did: "flagged" });
      } else {
        // A per run cap, so a bad rule or a bad dial can only ever eat one
        // batch before someone notices. The rest stay unscanned for next run.
        if (unsubscribed >= plan.maxUnsubscribes) {
          stoppedAtCap = true;
          break;
        }
        const result = await unsubscriber.unsubscribe(email);
        // Promotions mail is archived even when the sender's endpoint is dead:
        // what the user wants is that it is out of the inbox. For everything
        // else, production only archives what it could unsubscribe from, so a
        // failure leaves the message where it was, unflagged. That errs toward
        // keeping, but it also means the user is not told; see the README.
        if (result.ok || decision.decidedBy === "promotions") {
          await mailbox.modify(email.id, [EATEN_LABEL], ["INBOX"]);
          store.upsert(row("resolved", "unsubscribe"));
          unsubscribed++;
          handled.push({ email, decision, did: "eaten" });
        } else {
          errors++;
          handled.push({ email, decision, did: "left (unsubscribe failed)" });
        }
      }
      await mailbox.modify(id, [SCANNED_LABEL]);
    } catch {
      // Usually a message deleted between list and get. Label it scanned so
      // it cannot occupy a batch slot on every future run.
      errors++;
      await mailbox.modify(id, [SCANNED_LABEL]).catch(() => {});
    }
  }

  let staleBlocked: string[] = [];
  let trashed: string[] = [];
  if (mode === "maintain") {
    staleBlocked = await resolveStalePending(deps);
    trashed = await trashEaten(deps);
  }

  const counts = (d: Handled["did"]) => handled.filter((h) => h.did === d).length;
  store.addRun({
    id: runId,
    mode,
    startedAt: now().toISOString(),
    backlog,
    processed: handled.length,
    unsubscribed,
    flagged: counts("flagged"),
    kept: counts("kept"),
    errors,
  });

  const next = nextState(state, { backlog, unsubscribed }, now());
  next.aiDomainCache = detector.dumpCache();
  return { runId, mode, backlog, handled, stoppedAtCap, errors, staleBlocked, trashed, state: next };
}

/** Mode switching and the next run time. Pure, so the schedule can be tested without a mailbox. */
export function nextState(state: AgentState, run: { backlog: number; unsubscribed: number }, now: Date): AgentState {
  const next: AgentState = { ...state, totalRuns: state.totalRuns + 1 };
  if (state.mode === "clean" && run.backlog === 0) {
    // Zero means every message that was unread at connect time now carries
    // Gary-Scanned or Gary-Unsubscribed. No spam rate test: a big inbox with
    // little spam would otherwise be stranded half cleaned.
    next.mode = "maintain";
  } else if (
    state.mode === "maintain" &&
    (run.unsubscribed >= BACK_TO_CLEAN.unsubscribes || run.backlog >= BACK_TO_CLEAN.backlog)
  ) {
    next.mode = "clean";
  }
  let interval: number = MODES[next.mode].intervalMinutes;
  if (run.backlog === 0) {
    next.consecutiveZeroBacklog = state.consecutiveZeroBacklog + 1;
    interval = Math.min(interval * 2 ** next.consecutiveZeroBacklog, MAX_INTERVAL_MINUTES);
  } else {
    next.consecutiveZeroBacklog = 0;
  }
  next.nextRunAt = new Date(now.getTime() + interval * 60_000).toISOString();
  return next;
}

/**
 * Flags nobody reviewed in 30 days. Only those that scored within 0.1 of the
 * dial, the ones Gary was already leaning toward eating, are resolved as a
 * Block: archived under Gary-Unsubscribed, exactly as if the user had pressed
 * it. Lower scores stay pending until a person decides.
 */
export async function resolveStalePending({ mailbox, store, settings, now }: EngineDeps): Promise<string[]> {
  const line = thresholds(settings.spamScoreThreshold).staleAutoBlock;
  const cutoff = now().getTime() - PENDING_GRACE_DAYS * DAY;
  const due = store
    .rows()
    .filter((r) => r.status === "pending" && r.score >= line && Date.parse(r.createdAt) < cutoff)
    .slice(0, HOUSEKEEPING_BATCH);
  for (const r of due) {
    await mailbox.modify(r.messageId, [EATEN_LABEL], ["INBOX"]).catch(() => {});
    store.update(r.messageId, { status: "resolved", resolution: "blocked", resolvedAt: now().toISOString() });
  }
  return due.map((r) => r.messageId);
}

/**
 * Eaten mail moves to Trash a set number of days after Gary ate it, counted
 * from when Gary acted, not from when the mail was sent. Counting from the
 * send date once trashed a six month old message the morning it was eaten,
 * before the user could have noticed. Only eaten or blocked rows qualify;
 * kept, skipped and pending mail is never trashed.
 */
export async function trashEaten({ mailbox, store, settings, now }: EngineDeps): Promise<string[]> {
  if (!settings.autoTrashAfterDays) return [];
  const cutoff = now().getTime() - settings.autoTrashAfterDays * DAY;
  const due = store
    .rows()
    .filter(
      (r) =>
        (r.resolution === "unsubscribe" || r.resolution === "blocked") &&
        !r.trashedAt &&
        r.resolvedAt !== null &&
        Date.parse(r.resolvedAt) < cutoff,
    )
    .sort((a, b) => a.resolvedAt!.localeCompare(b.resolvedAt!))
    .slice(0, HOUSEKEEPING_BATCH);
  for (const r of due) {
    await mailbox.trash(r.messageId).catch(() => {});
    store.update(r.messageId, { trashedAt: now().toISOString() });
  }
  return due.map((r) => r.messageId);
}
