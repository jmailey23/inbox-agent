/**
 * The two buttons the user has: Keep and Block. Production exposes them on
 * the dashboard, the iOS app, and inside Gmail itself (move a message into a
 * Gary-Keep or Gary-Block label and a sweep picks it up).
 *
 * Both act on the whole domain, not one address. Senders rotate From
 * addresses, so an address only Keep protected one LinkedIn address while
 * Gary ate the other twelve.
 *
 * Each clears the other, so the user's most recent decision is the only one
 * on file, and Gary never writes to either list himself.
 */
import { EATEN_LABEL, type Mailbox } from "./mailbox.ts";
import type { Store } from "./store.ts";
import type { UserSettings } from "./types.ts";

const now = () => new Date().toISOString();

export async function keep(
  messageId: string,
  { settings, store, mailbox, at = now }: { settings: UserSettings; store: Store; mailbox: Mailbox; at?: () => string },
): Promise<{ restored: boolean }> {
  const row = store.get(messageId);
  if (!row) throw new Error(`no decision for ${messageId}`);
  const domain = row.senderDomain.toLowerCase();
  if (!settings.keepEmails.includes(row.sender)) settings.keepEmails.push(row.sender);
  if (!settings.keepDomains.includes(domain)) settings.keepDomains.push(domain);
  settings.blockDomains = settings.blockDomains.filter((d) => d.toLowerCase() !== domain);

  // Undo. If Gary ate this one, it goes back to the inbox. It is still there
  // to go back: eaten mail is archived, not deleted. As in production, only
  // Gary's own eats are reversed here; a message the user blocked stays put.
  const restored = row.resolution === "unsubscribe";
  if (restored) await mailbox.modify(messageId, ["INBOX"], [EATEN_LABEL]);
  store.update(messageId, { status: "resolved", resolution: "whitelist", resolvedAt: at() });
  return { restored };
}

export async function block(
  messageId: string,
  { settings, store, mailbox, at = now }: { settings: UserSettings; store: Store; mailbox: Mailbox; at?: () => string },
): Promise<{ alsoResolved: string[] }> {
  const row = store.get(messageId);
  if (!row) throw new Error(`no decision for ${messageId}`);
  const domain = row.senderDomain.toLowerCase();
  if (!settings.blockDomains.includes(domain)) settings.blockDomains.push(domain);
  settings.keepDomains = settings.keepDomains.filter((d) => d.toLowerCase() !== domain);
  settings.keepEmails = settings.keepEmails.filter((e) => !e.toLowerCase().endsWith(`@${domain}`));

  // Everything else this sender has waiting in the review queue goes with it,
  // subdomains included, so the user decides once per sender, not per message.
  const siblings = store
    .rows()
    .filter((r) => r.status === "pending" && (r.senderDomain === domain || r.senderDomain.endsWith(`.${domain}`)));
  const ids = [...new Set([messageId, ...siblings.map((r) => r.messageId)])];
  for (const id of ids) {
    await mailbox.modify(id, [EATEN_LABEL], ["INBOX"]);
    store.update(id, { status: "resolved", resolution: "blocked", resolvedAt: at() });
  }
  return { alsoResolved: ids.filter((id) => id !== messageId) };
}
