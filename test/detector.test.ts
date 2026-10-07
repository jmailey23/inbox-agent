import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { APPETITE, appetiteName, thresholds } from "../src/appetite.ts";
import { ClaudeClassifier, NoClassifier, type Classifier, type Verdict } from "../src/classifier.ts";
import { Detector, type Signals } from "../src/detector.ts";
import { checkBlock } from "../src/rules.ts";
import type { Email, UserSettings } from "../src/types.ts";
import { inbox, mail, NOW, settings } from "../demo/fixtures.ts";

const quiet: Signals = { sentLastWeek: 1, engaged: false };
const byId = (id: string) => inbox.find((m) => m.id === id)!;
const ledger = byId("m07"); // rule score 0.48: borderline
const friend = byId("m05"); // rule score 0: clearly wanted

/** A classifier that records what it was asked and always says the same thing. */
function spy(verdict: Verdict | null) {
  const asked: string[] = [];
  const c: Classifier = { classify: async (e) => (asked.push(e.id), verdict) };
  return { c, asked };
}
const unwanted: Verdict = { unwanted: true, confidence: 0.9, type: "newsletter", reason: "a daily digest" };
const wanted: Verdict = { unwanted: false, confidence: 0.9, type: "personal", reason: "a person" };

const detect = (over: Partial<UserSettings> = {}, c: Classifier = NoClassifier) =>
  new Detector({ ...settings(), ...over }, c, () => NOW);

test("a kept sender wins even when the same domain is also blocked", async () => {
  // The production regression: block ran first and ate 527 messages users had rescued.
  const d = detect({ keepDomains: ["ledgerdaily.example"], blockDomains: ["ledgerdaily.example"] });
  const r = await d.analyze(ledger, quiet);
  assert.equal(r.outcome, "keep");
  assert.equal(r.decidedBy, "keep_list");
});

test("a kept sender wins over Gmail's Promotions category", async () => {
  const r = await detect().analyze(byId("m03"), quiet);
  assert.deepEqual([r.outcome, r.decidedBy], ["keep", "keep_list"]);
});

test("protected domains and starred mail are kept without scoring", async () => {
  const promo = (over: Partial<Email>) => mail({ id: "x", from: "x@x.example", subject: "Sale", date: NOW.toISOString(), labels: ["UNREAD", "CATEGORY_PROMOTIONS"], ...over });
  assert.equal((await detect().analyze(promo({ from: "Apple <news@apple.com>" }), quiet)).outcome, "keep");
  assert.equal((await detect().analyze(promo({ labels: ["UNREAD", "STARRED", "CATEGORY_PROMOTIONS"] }), quiet)).outcome, "keep");
});

test("a block covers subdomains, not lookalike domains", () => {
  const lists = { keepEmails: [], keepDomains: [], blockDomains: ["brightcart.example"] };
  const from = (address: string) => mail({ id: "x", from: address, subject: "", date: NOW.toISOString() });
  assert.ok(checkBlock(from("deals@mail.brightcart.example"), lists));
  assert.equal(checkBlock(from("hi@notbrightcart.example"), lists), null);
});

test("Promotions is eaten without a model call, header or not", async () => {
  const { c, asked } = spy(wanted);
  const noHeader = mail({ id: "p", from: "Shop <a@shop.example>", subject: "Sale", date: NOW.toISOString(), labels: ["UNREAD", "CATEGORY_PROMOTIONS"] });
  const r = await detect({}, c).analyze(noHeader, quiet);
  assert.deepEqual([r.outcome, r.decidedBy, r.model], ["unsubscribe", "promotions", "not_reached"]);
  assert.equal(asked.length, 0);
});

test("the model is never asked about mail the rules already settled", async () => {
  const { c, asked } = spy(unwanted);
  const d = detect({}, c);
  for (const id of ["m01", "m02", "m03", "m04", "m05", "m06"]) await d.analyze(byId(id), quiet);
  assert.deepEqual(asked, []);
});

test("borderline mail goes to the model once per sender domain", async () => {
  const { c, asked } = spy(unwanted);
  const d = detect({}, c);
  const sequence = ["m10", "m11", "m12"].map(byId);
  const results = [];
  for (const m of sequence) results.push(await d.analyze(m, quiet));
  assert.deepEqual(asked, ["m10"]);
  assert.deepEqual(results.map((r) => r.model), ["asked", "cached", "cached"]);
});

test("the model's answer is weighed in, and the dial still applies after it", async () => {
  const { c } = spy(unwanted);
  // Balanced: rules said flag (0.48); "unwanted, 0.9" tips it over 0.5.
  const balanced = await detect({}, c).analyze(ledger, quiet);
  assert.equal(balanced.outcome, "unsubscribe");
  // Picky: the same answer is not enough on its own to clear 0.7.
  const picky = await detect({ spamScoreThreshold: APPETITE.picky }, spy(unwanted).c).analyze(ledger, quiet);
  assert.equal(picky.outcome, "flag");
  assert.equal(picky.score, balanced.score);
});

test("a confident keep from the model pulls a borderline score down", async () => {
  const r = await detect({}, spy(wanted).c).analyze(ledger, quiet);
  assert.equal(r.outcome, "keep");
  assert.ok(r.score < r.ruleScore);
});

test("no answer from the model leaves the rules to decide", async () => {
  const r = await detect({}, spy(null).c).analyze(ledger, quiet);
  assert.deepEqual([r.model, r.outcome, r.score], ["no_answer", "flag", r.ruleScore]);
});

test("reading a sender's mail dampens its score", async () => {
  const fieldNotes = byId("m09");
  const cold = await detect().analyze(fieldNotes, quiet);
  const warm = await detect().analyze(fieldNotes, { ...quiet, engaged: true });
  assert.equal(cold.outcome, "flag");
  assert.equal(warm.outcome, "keep");
});

test("a friend's note scores zero", async () => {
  const r = await detect().analyze(friend, quiet);
  assert.deepEqual([r.outcome, r.score, r.model], ["keep", 0, "outside_band"]);
});

test("cached verdicts expire after 30 days", async () => {
  const d = detect({}, spy(unwanted).c);
  d.loadCache({
    "fresh.example": { score: 0.9, reason: "x", ts: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() },
    "stale.example": { score: 0.9, reason: "x", ts: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() },
  });
  assert.deepEqual(Object.keys(d.dumpCache()), ["fresh.example"]);
});

test("the appetite dial moves all three lines together", () => {
  assert.deepEqual(thresholds(APPETITE.picky), { unsubscribe: 0.7, flag: 0.5, staleAutoBlock: 0.6 });
  assert.deepEqual(thresholds(APPETITE.balanced), { unsubscribe: 0.5, flag: 0.3, staleAutoBlock: 0.4 });
  assert.deepEqual(thresholds(APPETITE.ravenous), { unsubscribe: 0.3, flag: 0.1, staleAutoBlock: 0.2 });
  assert.deepEqual(thresholds(0), thresholds(0.3), "a bad row cannot set a dial that eats everything");
  assert.equal(appetiteName(0.52), "balanced");
});

/** A stand-in for the SDK client: just the one method the classifier calls. */
const fakeClient = (reply: object | Error) =>
  ({ beta: { messages: { parse: async () => { if (reply instanceof Error) throw reply; return reply; } } } }) as unknown as Anthropic;

test("Claude's structured answer is passed through", async () => {
  const c = new ClaudeClassifier({ client: fakeClient({ stop_reason: "end_turn", parsed_output: unwanted }) });
  assert.deepEqual(await c.classify(ledger), unwanted);
});

test("a refusal or an unparseable answer is no answer", async () => {
  const refused = new ClaudeClassifier({ client: fakeClient({ stop_reason: "refusal", parsed_output: null }) });
  assert.equal(await refused.classify(ledger), null);
  const empty = new ClaudeClassifier({ client: fakeClient({ stop_reason: "end_turn", parsed_output: null }) });
  assert.equal(await empty.classify(ledger), null);
});

test("Claude is shown the preview, never the body", async () => {
  let sent = "";
  const client = {
    beta: { messages: { parse: async (req: any) => ((sent = req.messages[0].content), { stop_reason: "end_turn", parsed_output: unwanted }) } },
  } as unknown as Anthropic;
  const withBody = { ...ledger, bodyText: "SECRET BODY TEXT" };
  await new ClaudeClassifier({ client }).classify(withBody);
  assert.ok(sent.includes(ledger.snippet));
  assert.ok(!sent.includes("SECRET BODY TEXT"));
});
