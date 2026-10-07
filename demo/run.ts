/**
 * npm run demo                   rules only, no network, no key
 * npm run demo -- --with-claude  borderline mail goes to Claude; needs ANTHROPIC_API_KEY
 *
 * A month of one fictional mailbox, on a fake clock.
 */
import { APPETITE, thresholds, type AppetiteName } from "../src/appetite.ts";
import { ClaudeClassifier, NoClassifier } from "../src/classifier.ts";
import { block, keep } from "../src/controls.ts";
import { runOnce, type EngineDeps, type Handled, type RunReport } from "../src/engine.ts";
import { EATEN_LABEL, FakeMailbox } from "../src/mailbox.ts";
import { MemoryStore } from "../src/store.ts";
import { StubUnsubscriber } from "../src/unsubscribe.ts";
import { initialState, type AgentState } from "../src/types.ts";
import { inbox, later, NOW, settings as maya } from "./fixtures.ts";

const withClaude = process.argv.includes("--with-claude");
let clock = new Date(NOW);
const now = () => clock;
const mailbox = new FakeMailbox(inbox, now);
const store = new MemoryStore();
const settings = maya();
const deps: EngineDeps = {
  mailbox,
  store,
  settings,
  now,
  classifier: withClaude ? new ClaudeClassifier() : NoClassifier,
  unsubscriber: new StubUnsubscriber(),
};
let state: AgentState = initialState();

const when = (d: Date | string) =>
  new Date(d).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const name = (from: string) => from.replace(/\s*<.*$/, "");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "~" : s).padEnd(n);

const DID: Record<Handled["did"], string> = {
  eaten: "EAT ",
  flagged: "FLAG",
  kept: "keep",
  "left (unsubscribe failed)": "LEFT",
};

function why(h: Handled): string {
  const d = h.decision;
  if (d.decidedBy !== "score") return `${d.decidedBy.replace("_", " ")}: ${d.reason}`;
  const model =
    d.model === "outside_band" ? "rules alone, model not needed"
    : d.model === "no_answer" ? "borderline, no model: rules decide"
    : d.model === "cached" ? "model, cached for this sender"
    : "model asked";
  const engaged = d.layers.some((l) => l.layer === "engagement") ? ", dampened: she reads this sender" : "";
  return `score ${d.score.toFixed(2)} (rules ${d.ruleScore.toFixed(2)}; ${model}${engaged})`;
}

async function run(label: string) {
  const r: RunReport = await runOnce(deps, state);
  const switched = r.state.mode !== state.mode ? `  Switched to ${r.state.mode === "maintain" ? "Maintain" : "Deep Clean"}.` : "";
  state = r.state;
  const mode = r.mode === "clean" ? "Deep Clean, oldest first" : "Maintain, newest first";
  console.log(`\n${label}  ${when(clock)}  ${mode}, ${r.backlog} unread unscanned`);
  for (const h of r.handled) {
    console.log(`  ${h.email.id}  ${DID[h.did]}  ${cut(name(h.email.from), 27)} ${why(h)}`);
  }
  for (const id of r.staleBlocked) {
    const row = store.get(id)!;
    console.log(`  ${id}  BLOCK  flag unreviewed for 30 days, score ${row.score.toFixed(2)} over the stale line ${thresholds(settings.spamScoreThreshold).staleAutoBlock}`);
  }
  if (r.trashed.length) console.log(`  to Trash, 30 days after Gary ate them: ${r.trashed.join(", ")}`);
  if (!r.handled.length && !r.staleBlocked.length && !r.trashed.length) console.log("  nothing to do: every message already carries Gary-Scanned");
  console.log(`  next run ${when(r.state.nextRunAt!)}.${switched}`);
}

const t = thresholds(settings.spamScoreThreshold);
console.log(
  `Maya's inbox: ${await mailbox.countBacklog()} unread, the oldest from ${when(inbox[0].date).split(",")[0]} 2025. ` +
    `Appetite: Balanced (eat at ${t.unsubscribe}, flag at ${t.flag}). Model: ${withClaude ? "Claude" : "none"}.`,
);

await run("Run 1");
clock = new Date(state.nextRunAt!);
await run("Run 2");

console.log(`\nMaya opens her review queue  ${when("2026-10-08T09:00:00Z")}`);
const at = () => "2026-10-08T09:00:00.000Z";
const firstGrowth = store.rows().find((r) => r.senderDomain === "growthloop.example" && r.status === "pending");
if (firstGrowth) {
  const b = await block(firstGrowth.messageId, { settings, store, mailbox, at });
  console.log(`  Block growthloop.example   ${[firstGrowth.messageId, ...b.alsoResolved].join(", ")} archived under ${EATEN_LABEL}`);
}
const k = await keep("m01", { settings, store, mailbox, at });
console.log(`  Keep tidewater.example     m01 ${k.restored ? "moved back to the inbox: Gary had only archived it" : "kept"}`);
const pending = store.rows().filter((r) => r.status === "pending").map((r) => r.messageId);
console.log(`  left for later             ${pending.join(", ") || "nothing"}`);

clock = new Date("2026-10-08T16:30:00Z");
later.forEach((m) => mailbox.deliver(m));
await run("Run 3");

// A month of quiet maintain runs later.
clock = new Date("2026-11-08T16:00:00Z");
await run("Run 4");

const all = mailbox.all();
const count = (f: (labels: string[]) => boolean) => all.filter((m) => f(m.labels)).length;
console.log(
  `\nA month on: ${count((l) => l.includes("TRASH"))} in Trash (recoverable), ` +
    `${count((l) => l.includes(EATEN_LABEL) && !l.includes("TRASH"))} archived under ${EATEN_LABEL}, ` +
    `${count((l) => l.includes("INBOX"))} in the inbox (${store.rows().filter((r) => r.status === "pending").length} of them waiting for Maya), 0 deleted.`,
);

// The same messages at every setting of the dial, rules only.
console.log("\nThe appetite dial, on the same scores");
const names = Object.keys(APPETITE) as AppetiteName[];
console.log(`  ${"".padEnd(32)}score  ${names.map((n) => cut(`${n} ${APPETITE[n]}`, 14)).join("").trimEnd()}`);
for (const id of ["m02", "m03", "m07", "m10", "m08", "m09"]) {
  const row = store.get(id)!;
  // The lists are the user's own decisions, and the dial does not touch them.
  const fixed = row.reason.startsWith("you kept") ? "keep" : row.reason.startsWith("you blocked") ? "eat" : null;
  const cells = names.map((n) => {
    if (fixed) return fixed;
    const th = thresholds(APPETITE[n]);
    return row.score >= th.unsubscribe ? "eat" : row.score >= th.flag ? "flag" : "keep";
  });
  const score = (fixed ? "  -" : row.score.toFixed(2)).padEnd(5);
  console.log(`  ${id}  ${cut(name(inbox.find((m) => m.id === id)!.from), 27)}${score}  ${cells.map((c) => c.padEnd(14)).join("").trimEnd()}`);
}
