/**
 * The model half of the detector.
 *
 * Claude is only asked about mail the rules could not settle: a rule score
 * between 0.3 and 0.7. Mail the rules call clearly wanted or clearly bulk never
 * reaches it, and a sender is classified once and cached by domain, so the
 * bill scales with new senders, not with mail.
 *
 * Its answer is not a decision. It becomes one input to the score, weighted
 * at half, next to the marketing, keyword and frequency layers, and the score
 * still has to clear the user's appetite dial. A refusal, an error or no key
 * at all leaves the rules to decide alone.
 *
 * What the model is shown: sender, subject, Gmail's preview text, whether
 * there is an unsubscribe header, and Gmail's category. Not the body.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Email } from "./types.ts";

export interface Verdict {
  unwanted: boolean;
  confidence: number;
  type: "retail" | "newsletter" | "sports" | "finance" | "political" | "transactional" | "personal" | "other";
  reason: string;
}

export interface Classifier {
  classify(email: Email): Promise<Verdict | null>;
}

/** For running without a model. Borderline mail is then decided by the rules alone. */
export const NoClassifier: Classifier = { classify: async () => null };

/**
 * A verdict as a 0 to 1 score. "Unwanted at 0.9" is 0.9. "Keep at 0.9" is
 * 0.015, near zero but not zero, so it still pulls the weighted score down
 * instead of being read as "no answer".
 */
export const verdictScore = (v: Verdict) => (v.unwanted ? v.confidence : Math.max(0, (1 - v.confidence) * 0.15));

const VerdictSchema = z.object({
  unwanted: z.boolean().describe("True for bulk commercial mail the user did not personally ask for."),
  confidence: z.number().min(0).max(1),
  type: z.enum(["retail", "newsletter", "sports", "finance", "political", "transactional", "personal", "other"]),
  reason: z.string().describe("One sentence."),
});

export interface ClaudeClassifierOptions {
  client?: Anthropic;
  model?: string;
}

export class ClaudeClassifier implements Classifier {
  private client: Anthropic;
  private model: string;

  constructor(opts: ClaudeClassifierOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.INBOX_AGENT_MODEL ?? "claude-opus-5-5";
  }

  async classify(email: Email): Promise<Verdict | null> {
    const category = email.labels.includes("CATEGORY_PROMOTIONS")
      ? "Promotions"
      : email.labels.includes("CATEGORY_UPDATES")
        ? "Updates"
        : email.labels.includes("CATEGORY_SOCIAL")
          ? "Social"
          : "Primary";
    const prompt =
      "You help decide what to unsubscribe from in a personal inbox.\n\n" +
      `From: ${email.from}\nSubject: ${email.subject}\nPreview: ${email.snippet.slice(0, 250)}\n` +
      `Has unsubscribe header: ${email.listUnsubscribe ? "yes" : "no"}\nGmail category: ${category}\n\n` +
      "Unwanted: brand promotions and sales, company newsletters and digests, re-engagement mail, " +
      "platform marketing not tied to something the user did, political or advocacy fundraising, " +
      "any bulk commercial mail the user did not personally request.\n" +
      "Keep: receipts, shipping and delivery updates, security and account alerts, bills and statements, " +
      "calendar invites, and direct personal mail from a real person.\n" +
      // Production's instruction, kept as is. Doubt is handled by the score,
      // not the prompt: this answer is half of it, and only on borderline mail.
      "The user wants an aggressive cleanup: when in doubt, unwanted.";
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 1024,
        output_config: { effort: "low", format: betaZodOutputFormat(VerdictSchema) },
        // On a policy decline the API re-runs the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      });
      if (response.stop_reason === "refusal") return null;
      return (response.parsed_output as Verdict | null) ?? null;
    } catch (error) {
      // The model is an extra. A failed call leaves the rules to decide; it
      // never stops a run.
      if (error instanceof Anthropic.APIError) {
        console.warn(`classification skipped: ${error.status} ${error.message}`);
        return null;
      }
      throw error;
    }
  }
}
