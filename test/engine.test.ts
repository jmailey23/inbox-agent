import assert from "node:assert/strict";
import { test } from "node:test";
import { NoClassifier } from "../src/classifier.ts";
import { block, keep } from "../src/controls.ts";
import { MODES, nextState, runOnce, type EngineDeps } from "../src/engine.ts";
import { EATEN_LABEL, FakeMailbox, SCANNED_LABEL } from "../src/mailbox.ts";
import { MemoryStore } from "../src/store.ts";
import { StubUnsubscriber } from "../src/unsubscribe.ts";
import { initialState, type AgentState, type Email } from "../src/types.ts";
import { inbox, mail, NOW, settings } from "../demo/fixtures.ts";

const DAY = 86_400_000;

function setup(seed: Email[] = inbox, dead: string[] = []) {
  let clock = new Date(NOW);
  const mailbox = new FakeMailbox(seed, () => clock);
  const store = new MemoryStore();
  const deps: EngineDeps = {
    mailbox,
    store,
    settings: settings(),
    classifier: NoClassifier,
    unsubscriber: new StubUnsubscriber(dead),
    now: () => clock,
  };
  const at = (d: Date) => (clock = d);
  return { mailbox, store, deps, at };
}

/** n Promotions messages, one a day, oldest first. */
const promos = (n: number, from = "Shop <deals@shop.example>") =>
  Array.from({ length: n }, (_, i) =>
    mail({
      id: `p${String(i).padStart(3, "0")}`,
      from,
      subject: `Deal ${i}`,
      date: new Date(Date.parse("2025-01-01T00:00:00Z") + i * DAY).toISOString(),
      labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
      listUnsubscribe: "<https://shop.example/u>",
    }),
  );

test("Deep Clean takes the oldest 100 first", async () => {
  const { deps } = setup(promos(130).map((m) => ({ ...m, labels: ["INBOX", "UNREAD"] })));
  const r = await runOnce(deps, initialState());
  assert.equal(r.backlog, 130);
  assert.equal(r.handled.length, MODES.clean.batch);
  assert.equal(r.handled[0].email.id, "p000");
  assert.equal(r.handled.at(-1)!.email.id, "p099");
});

test("Maintain takes the newest 25", async () => {
  const { deps } = setup(promos(40).map((m) => ({ ...m, labels: ["INBOX", "UNREAD"] })));
  const r = await runOnce(deps, { ...initialState(), mode: "maintain" });
  assert.equal(r.handled.length, MODES.maintain.batch);
  assert.equal(r.handled[0].email.id, "p039");
});

test("one run eats at most 50; the rest wait, unscanned, for the next", async () => {
  const { deps, mailbox } = setup(promos(80));
  const r = await runOnce(deps, initialState());
  assert.equal(r.handled.filter((h) => h.did === "eaten").length, 50);
  assert.equal(r.stoppedAtCap, true);
  assert.equal(await mailbox.countBacklog(), 30);
});

test("a second run decides nothing twice", async () => {
  const { deps, store, mailbox } = setup();
  const first = await runOnce(deps, initialState());
  const rows = store.rows().length;
  const second = await runOnce(deps, first.state);
  assert.equal(second.handled.length, 0);
  assert.equal(store.rows().length, rows);
  assert.ok(mailbox.all().filter((m) => m.labels.includes("UNREAD")).every((m) => m.labels.includes(SCANNED_LABEL)));
});

test("unsure mail is flagged and left exactly where it was", async () => {
  const { deps, mailbox, store } = setup();
  const r = await runOnce(deps, initialState());
  const flagged = r.handled.filter((h) => h.did === "flagged").map((h) => h.email.id);
  assert.deepEqual(flagged, ["m07", "m08", "m10", "m11", "m12"]);
  for (const id of flagged) {
    assert.ok(mailbox.peek(id).labels.includes("INBOX"));
    assert.ok(!mailbox.peek(id).labels.includes(EATEN_LABEL));
    assert.equal(store.get(id)!.status, "pending");
  }
});

test("eaten mail is archived under a label, not deleted", async () => {
  const { deps, mailbox } = setup();
  await runOnce(deps, initialState());
  assert.deepEqual(mailbox.peek("m01").labels.filter((l) => ["INBOX", EATEN_LABEL, "TRASH"].includes(l)), [EATEN_LABEL]);
});

test("Promotions is archived even when the unsubscribe endpoint is dead", async () => {
  const { deps, mailbox } = setup([inbox[0]], ["tidewater.example"]);
  const r = await runOnce(deps, initialState());
  assert.equal(r.handled[0].did, "eaten");
  assert.ok(mailbox.peek("m01").labels.includes(EATEN_LABEL));
});

test("scored mail whose unsubscribe fails stays in the inbox", async () => {
  // Production behavior, kept here on purpose: it errs toward keeping.
  const loud = mail({
    id: "s1", from: "Promo <newsletter@mail.loud.example>", subject: "Sale today only", date: NOW.toISOString(),
    listUnsubscribe: "<https://loud.example/u>", labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    bodyText: "sale, today only, last chance, act now, exclusive deal, newsletter",
    bodyHtml: '<a href="https://loud.example/unsubscribe">unsubscribe</a><img src="https://loud.example/tracking.gif">',
  });
  const { deps, mailbox, store } = setup([loud], ["mail.loud.example"]);
  const r = await runOnce(deps, initialState());
  assert.equal(r.handled[0].decision.outcome, "unsubscribe");
  assert.equal(r.handled[0].did, "left (unsubscribe failed)");
  assert.ok(mailbox.peek("s1").labels.includes("INBOX"));
  assert.equal(store.get("s1"), undefined);
});

test("Deep Clean hands over to Maintain when the backlog is empty, with backoff", () => {
  const t0 = new Date("2026-10-07T00:00:00Z");
  const s1 = nextState(initialState(), { backlog: 12, unsubscribed: 3 }, t0);
  assert.equal(s1.mode, "clean");
  assert.equal(Date.parse(s1.nextRunAt!) - t0.getTime(), 30 * 60_000);
  const s2 = nextState(s1, { backlog: 0, unsubscribed: 0 }, t0);
  assert.equal(s2.mode, "maintain");
  assert.equal(Date.parse(s2.nextRunAt!) - t0.getTime(), 240 * 60_000, "120 doubled, capped at 240");
});

test("Maintain goes back to Deep Clean on a spam burst or a pile up", () => {
  const m: AgentState = { ...initialState(), mode: "maintain" };
  assert.equal(nextState(m, { backlog: 5, unsubscribed: 10 }, NOW).mode, "clean");
  assert.equal(nextState(m, { backlog: 100, unsubscribed: 0 }, NOW).mode, "clean");
  assert.equal(nextState(m, { backlog: 99, unsubscribed: 9 }, NOW).mode, "maintain");
});

test("a stale flag is blocked only after 30 days, and only if it leaned toward spam", async () => {
  const { deps, store, mailbox, at } = setup();
  const first = await runOnce(deps, initialState());
  const maintain = { ...first.state, mode: "maintain" as const };

  at(new Date(NOW.getTime() + 29 * DAY));
  assert.deepEqual((await runOnce(deps, maintain)).staleBlocked, []);

  at(new Date(NOW.getTime() + 31 * DAY));
  const late = await runOnce(deps, maintain);
  // Balanced: the stale line is 0.4. Ledger (0.48) and the sales sequence
  // (0.41) go; the garden list (0.34) waits for a person, indefinitely.
  assert.deepEqual(late.staleBlocked.sort(), ["m07", "m10", "m11", "m12"]);
  assert.equal(store.get("m08")!.status, "pending");
  assert.ok(mailbox.peek("m08").labels.includes("INBOX"));
});

test("Trash comes 30 days after Gary acted, never from the send date, and only for eaten mail", async () => {
  const { deps, mailbox, at } = setup();
  const first = await runOnce(deps, initialState());
  const maintain = { ...first.state, mode: "maintain" as const };
  // m01 was sent in 2025, but Gary ate it today: not due yet.
  assert.deepEqual((await runOnce(deps, maintain)).trashed, []);
  at(new Date(NOW.getTime() + 31 * DAY));
  const r = await runOnce(deps, maintain);
  assert.deepEqual(r.trashed.sort(), ["m01", "m02"]);
  const trashed = mailbox.all().filter((m) => m.labels.includes("TRASH")).map((m) => m.id);
  assert.deepEqual(trashed.sort(), ["m01", "m02"], "kept, skipped and pending mail is never trashed");
});

test("Keep undoes an eat and clears the block; future mail from the sender is kept", async () => {
  const { deps, mailbox, store } = setup([inbox[0]]);
  deps.settings.blockDomains.push("tidewater.example");
  await runOnce(deps, initialState());
  const { restored } = await keep("m01", deps);
  assert.equal(restored, true);
  assert.ok(mailbox.peek("m01").labels.includes("INBOX"));
  assert.ok(!mailbox.peek("m01").labels.includes(EATEN_LABEL));
  assert.ok(!deps.settings.blockDomains.includes("tidewater.example"));

  mailbox.deliver(mail({ ...inbox[0], id: "m01b", date: NOW.toISOString() }));
  const r = await runOnce(deps, initialState());
  assert.deepEqual([r.handled[0].decision.outcome, r.handled[0].decision.decidedBy], ["keep", "keep_list"]);
  assert.equal(store.get("m01")!.resolution, "whitelist");
});

test("Block clears the keep and resolves the sender's whole queue", async () => {
  const { deps, mailbox, store } = setup();
  await runOnce(deps, initialState());
  deps.settings.keepDomains.push("growthloop.example");
  const { alsoResolved } = await block("m10", deps);
  assert.deepEqual(alsoResolved.sort(), ["m11", "m12"]);
  assert.ok(!deps.settings.keepDomains.includes("growthloop.example"));
  for (const id of ["m10", "m11", "m12"]) {
    assert.equal(store.get(id)!.resolution, "blocked");
    assert.ok(mailbox.peek(id).labels.includes(EATEN_LABEL));
  }
});
