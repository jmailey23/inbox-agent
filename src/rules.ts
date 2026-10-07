/**
 * The deterministic layers.
 *
 * Every one of these is a plain rule: free, instant, and the same answer every
 * time. They run before the model and settle most mail on their own. The
 * first three short circuit; the rest produce a score.
 *
 *   1. keep list      the user said keep            -> keep, nothing else runs
 *   2. block list     the user said block           -> unsubscribe
 *   3. promotions     Gmail already filed it there  -> unsubscribe
 *   4. keywords, sending frequency, marketing patterns -> a weighted score
 *
 * The weights and point values are production's, unchanged.
 */
import type { Email, LayerResult, UserLists } from "./types.ts";

/**
 * Domains nobody should lose mail from by accident: password resets, receipts,
 * security alerts. Always kept, whatever the user's lists say.
 */
export const PROTECTED_DOMAINS = ["google.com", "github.com", "apple.com", "microsoft.com", "amazon.com"];

export const DEFAULT_KEYWORDS = [
  "unsubscribe", "promotional", "sale", "limited offer", "act now", "exclusive deal",
  "special offer", "don't miss", "last chance", "today only", "free trial", "opt out",
  "manage preferences", "email preferences", "no longer wish", "marketing", "newsletter",
];

/** "Harbor Bank <Alerts@HarborBank.example>" -> "alerts@harborbank.example" */
export function addressOf(header: string): string {
  const angled = /<([^>]+)>/.exec(header);
  if (angled) return angled[1].trim().toLowerCase();
  return (/[\w.+-]+@[\w.-]+/.exec(header)?.[0] ?? header).trim().toLowerCase();
}

export const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";

/**
 * Layer 1. Runs first, and that order is the whole point.
 *
 * In production it once ran second, after the block list. A domain that was
 * on both lists got eaten even though the user had pressed Keep on it, and
 * real users lost 527 messages they had rescued by hand. The one control the
 * user is given has to win.
 */
export function checkKeep(email: Email, lists: UserLists): LayerResult | null {
  const sender = email.sender.toLowerCase();
  const domain = email.senderDomain.toLowerCase();
  if (lists.keepEmails.some((e) => e.toLowerCase() === sender)) {
    return { layer: "keep_list", score: 0, reason: `you kept ${sender}` };
  }
  if (lists.keepDomains.some((d) => d.toLowerCase() === domain)) {
    return { layer: "keep_list", score: 0, reason: `you kept ${domain}` };
  }
  if (PROTECTED_DOMAINS.includes(domain)) {
    return { layer: "keep_list", score: 0, reason: `${domain} is protected` };
  }
  if (email.labels.includes("STARRED")) {
    return { layer: "keep_list", score: 0, reason: "you starred it" };
  }
  return null;
}

/** Layer 2. A blocked domain covers its subdomains: block brightcart.example, eat mail.brightcart.example. */
export function checkBlock(email: Email, lists: UserLists): LayerResult | null {
  const domain = email.senderDomain.toLowerCase();
  const hit = lists.blockDomains.find((b) => domain === b.toLowerCase() || domain.endsWith(`.${b.toLowerCase()}`));
  return hit ? { layer: "block_list", score: 1, reason: `you blocked ${hit}` } : null;
}

/**
 * Layer 3. Google has already done commercial mail detection on every message
 * it files under Promotions. Trusting it is free, and it is what settles most
 * of a real backlog without a model call. The keep list still runs first.
 */
export function checkPromotions(email: Email): LayerResult | null {
  if (!email.labels.includes("CATEGORY_PROMOTIONS")) return null;
  const how = email.listUnsubscribe ? "with" : "without";
  return { layer: "promotions", score: 1, reason: `Gmail filed it under Promotions (${how} List-Unsubscribe)` };
}

/** Layer 4a. Ratio of the keyword list that appears in the subject, preview and top of the body. */
export function checkKeywords(email: Email, keywords = DEFAULT_KEYWORDS): LayerResult {
  const text = `${email.subject} ${email.snippet} ${email.bodyText.slice(0, 1000)}`.toLowerCase();
  const hits = keywords.filter((k) => text.includes(k.toLowerCase()));
  if (!hits.length) return { layer: "keywords", score: 0, reason: "no keywords" };
  const score = Math.min(hits.length / Math.max(keywords.length * 0.3, 1), 1);
  return { layer: "keywords", score, reason: `keywords: ${hits.slice(0, 5).join(", ")}` };
}

/** Layer 4b. More than five a week from one sender is a signal; it scales with the excess. */
export function checkFrequency(sentLastWeek: number, maxPerWeek = 5): LayerResult {
  if (sentLastWeek <= maxPerWeek) {
    return { layer: "frequency", score: 0, reason: `${sentLastWeek} this week` };
  }
  const score = Math.min(0.5 + ((sentLastWeek - maxPerWeek) / maxPerWeek) * 0.25, 1);
  return { layer: "frequency", score, reason: `${sentLastWeek} this week, over ${maxPerWeek}` };
}

const MARKETING_SENDER = [
  /no[-_]?reply@/, /newsletter@/, /marketing@/, /promotions?@/, /info@/, /updates?@/, /digest@/,
  /notifications?@/, /mailer@/, /campaign@/, /announce@/, /hello@/, /team@/,
];
const MARKETING_DOMAIN = [/mail\./, /email\./, /send\./, /newsletter\./, /campaign\./, /promo\./, /marketing\./];

/** Layer 4c. The shape of bulk mail: list headers, bulk sender names, tracking pixels. */
export function checkMarketing(email: Email): LayerResult {
  const signals: [string, number][] = [];
  if (email.listUnsubscribe) signals.push(["List-Unsubscribe header", 0.3]);
  if (email.labels.includes("CATEGORY_PROMOTIONS")) signals.push(["Promotions category", 0.8]);
  if (email.labels.includes("CATEGORY_UPDATES")) signals.push(["Updates category", 0.1]);
  if (MARKETING_SENDER.some((p) => p.test(email.sender))) signals.push(["bulk sender address", 0.15]);
  if (MARKETING_DOMAIN.some((p) => p.test(email.senderDomain))) signals.push(["bulk sending domain", 0.1]);
  const html = email.bodyHtml.toLowerCase();
  if (html) {
    if (email.bodyHtml.length > 5000) signals.push(["long HTML body", 0.05]);
    if (html.includes("unsubscribe")) signals.push(["unsubscribe link in body", 0.1]);
    if (/<img[^>]*src=.*tracking/.test(html)) signals.push(["tracking pixel", 0.1]);
  }
  if (!signals.length) return { layer: "marketing", score: 0, reason: "no marketing signals" };
  const score = Math.min(signals.reduce((s, [, w]) => s + w, 0), 1);
  return { layer: "marketing", score, reason: signals.map(([n]) => n).join(", ") };
}

/**
 * Rule only weights. Marketing shape carries the score because keywords and
 * frequency rarely fire on their own.
 */
export const RULE_WEIGHTS = { keywords: 0.15, frequency: 0.15, marketing: 0.7 };

/** When the model has answered, it carries half the score and the rules the rest. */
export const MODEL_WEIGHTS = { model: 0.5, marketing: 0.3, keywords: 0.15, frequency: 0.05 };

/** Opened two or more of this sender's messages in 90 days: the score is multiplied by this. */
export const ENGAGEMENT_DAMPENER = 0.6;
