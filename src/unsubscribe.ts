/**
 * Asking a sender to stop.
 *
 * Production tries, in order: the List-Unsubscribe URL (an RFC 8058 one-click
 * POST when the sender supports it, otherwise a GET and, if the page asks
 * "are you sure", one form submit), then an unsubscribe link scraped from the
 * body. Success means a 2xx on one-click, or a page that actually says you
 * were removed; a preferences page full of checkboxes is not counted.
 *
 * Mailto unsubscribes are off. Each one sends real mail from the user's
 * account, and dead list addresses bounce back into the inbox Gary is meant
 * to be clearing.
 *
 * That is all network code, so it sits behind this interface.
 * StubUnsubscriber answers from the message alone.
 */
import type { Email } from "./types.ts";

export interface UnsubscribeResult {
  ok: boolean;
  method: "http" | "body_link" | "none";
  detail: string;
}

export interface Unsubscriber {
  unsubscribe(email: Email): Promise<UnsubscribeResult>;
}

export class StubUnsubscriber implements Unsubscriber {
  /** Sender domains whose unsubscribe endpoint is broken. */
  constructor(private dead: string[] = []) {}

  readonly calls: string[] = [];

  async unsubscribe(email: Email): Promise<UnsubscribeResult> {
    this.calls.push(email.id);
    const broken = this.dead.includes(email.senderDomain);
    if (/<https?:/.test(email.listUnsubscribe)) {
      return broken
        ? { ok: false, method: "http", detail: "HTTP 200 but not a confirmed success" }
        : { ok: true, method: "http", detail: "one-click" };
    }
    if (/href="https?:[^"]*unsubscribe/i.test(email.bodyHtml) && !broken) {
      return { ok: true, method: "body_link", detail: "link in body" };
    }
    return { ok: false, method: "none", detail: "no unsubscribe method found" };
  }
}
