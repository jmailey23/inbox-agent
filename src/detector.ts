/**
 * One message in, one decision out: keep, unsubscribe, or flag for a person.
 *
 *   1. The user's keep list. A kept sender wins over everything below.
 *   2. The user's block list.
 *   3. Gmail's Promotions category.
 *   4. Keywords, sending frequency and marketing shape, as a rule score.
 *   5. Only if that score is borderline (0.3 to 0.7): ask the model, once per
 *      sender domain, and weigh its answer in.
 *   6. If the user reads this sender, dampen the score.
 *   7. Compare the score with the user's appetite dial.
 *
 * Steps 1 to 4 are rules, and they settle most mail. The model never sees a
 * message a rule already decided, and it never decides alone.
 */
import { thresholds } from "./appetite.ts";
import { verdictScore, type Classifier } from "./classifier.ts";
import {
  checkBlock, checkFrequency, checkKeep, checkKeywords, checkMarketing, checkPromotions,
  ENGAGEMENT_DAMPENER, MODEL_WEIGHTS, RULE_WEIGHTS,
} from "./rules.ts";
import type { AgentState, Decision, Email, LayerResult, UserSettings } from "./types.ts";

export const MODEL_BAND = { low: 0.3, high: 0.7 };
export const MODEL_CACHE_TTL_DAYS = 30;
export const MODEL_CACHE_MAX = 5000;

/** What the engine looks up in the mailbox for each message. */
export interface Signals {
  /** Messages from this sender in the last 7 days. */
  sentLastWeek: number;
  /** The user has opened two or more of this sender's messages in 90 days. */
  engaged: boolean;
}

type Cache = AgentState["aiDomainCache"];

export class Detector {
  private cache: Cache = {};

  constructor(
    private settings: UserSettings,
    private classifier: Classifier,
    private now: () => Date = () => new Date(),
  ) {}

  /** Reuse verdicts from earlier runs, dropping any older than the TTL. */
  loadCache(saved: Cache) {
    const cutoff = this.now().getTime() - MODEL_CACHE_TTL_DAYS * 86_400_000;
    for (const [domain, entry] of Object.entries(saved)) {
      if (Date.parse(entry.ts) >= cutoff) this.cache[domain] = entry;
    }
  }

  /** The newest entries, capped, for the next run. */
  dumpCache(): Cache {
    const entries = Object.entries(this.cache).sort((a, b) => b[1].ts.localeCompare(a[1].ts));
    return Object.fromEntries(entries.slice(0, MODEL_CACHE_MAX));
  }

  async analyze(email: Email, signals: Signals): Promise<Decision> {
    const t = thresholds(this.settings.spamScoreThreshold);
    const layers: LayerResult[] = [];

    const settled = (outcome: Decision["outcome"], decidedBy: Decision["decidedBy"], hit: LayerResult): Decision => {
      layers.push(hit);
      return { outcome, decidedBy, score: hit.score, ruleScore: hit.score, model: "not_reached", layers, reason: hit.reason };
    };
    const keep = checkKeep(email, this.settings);
    if (keep) return settled("keep", "keep_list", keep);
    const block = checkBlock(email, this.settings);
    if (block) return settled("unsubscribe", "block_list", block);
    const promo = checkPromotions(email);
    if (promo) return settled("unsubscribe", "promotions", promo);

    const keywords = checkKeywords(email);
    const frequency = checkFrequency(signals.sentLastWeek);
    const marketing = checkMarketing(email);
    layers.push(keywords, frequency, marketing);
    const ruleScore =
      keywords.score * RULE_WEIGHTS.keywords +
      frequency.score * RULE_WEIGHTS.frequency +
      marketing.score * RULE_WEIGHTS.marketing;

    // The model is asked only when the rules are unsure, or when this sender
    // is already in the cache, which costs nothing.
    let model: Decision["model"] = "outside_band";
    let modelScore = 0;
    const domain = email.senderDomain.toLowerCase();
    const cached = this.cache[domain];
    if (cached) {
      model = "cached";
      modelScore = cached.score;
      layers.push({ layer: "model", score: cached.score, reason: `cached: ${cached.reason}` });
    } else if (ruleScore >= MODEL_BAND.low && ruleScore <= MODEL_BAND.high) {
      const verdict = await this.classifier.classify(email);
      if (verdict) {
        model = "asked";
        modelScore = verdictScore(verdict);
        const reason = `${verdict.unwanted ? "unwanted" : "keep"} (${Math.round(verdict.confidence * 100)}%, ${verdict.type}): ${verdict.reason}`;
        this.cache[domain] = { score: modelScore, reason, ts: this.now().toISOString() };
        layers.push({ layer: "model", score: modelScore, reason });
      } else {
        model = "no_answer";
        layers.push({ layer: "model", score: 0, reason: "borderline, no model answer: the rules decide" });
      }
    }

    let score =
      modelScore > 0
        ? modelScore * MODEL_WEIGHTS.model +
          marketing.score * MODEL_WEIGHTS.marketing +
          keywords.score * MODEL_WEIGHTS.keywords +
          frequency.score * MODEL_WEIGHTS.frequency
        : ruleScore;

    // Reading a sender's mail is evidence of wanting it. Not enough to keep it
    // outright (that is what Keep and starring are for), but enough to tip a
    // borderline sender from eaten to flagged, or flagged to kept.
    if (signals.engaged) {
      score *= ENGAGEMENT_DAMPENER;
      layers.push({ layer: "engagement", score: 0, reason: `you have opened mail from ${email.sender} before` });
    }
    score = Math.min(score, 1);

    const outcome = score >= t.unsubscribe ? "unsubscribe" : score >= t.flag ? "flag" : "keep";
    const verb = outcome === "unsubscribe" ? "at or over" : outcome === "flag" ? "in the flag band under" : "under";
    return {
      outcome,
      decidedBy: "score",
      score,
      ruleScore,
      model,
      layers,
      reason: `score ${score.toFixed(2)} ${verb} ${outcome === "keep" ? t.flag : t.unsubscribe}`,
    };
  }
}
