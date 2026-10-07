/**
 * Maya Torres and everyone who writes to her are fictional; every domain is
 * under .example. The mix is not: a year of unread backlog, a bank, a friend,
 * receipts, newsletters she reads and newsletters she does not, a cold sales
 * sequence, and a community list that could go either way.
 */
import { addressOf, domainOf } from "../src/rules.ts";
import type { Email, UserSettings } from "../src/types.ts";
import { DEFAULT_APPETITE } from "../src/appetite.ts";

export const NOW = new Date("2026-10-07T14:00:00Z");

export function mail(over: Partial<Email> & Pick<Email, "id" | "from" | "subject" | "date">): Email {
  const sender = addressOf(over.from);
  return {
    sender,
    senderDomain: domainOf(sender),
    snippet: over.subject,
    bodyText: "",
    bodyHtml: "",
    listUnsubscribe: "",
    labels: ["INBOX", "UNREAD"],
    ...over,
  };
}

const unsub = (domain: string) => `<https://${domain}/u/1>, <mailto:leave@${domain}>`;
const pad = "<p>" + "Lorem ipsum dolor sit amet. ".repeat(200) + "</p>";

export const settings = (): UserSettings => ({
  spamScoreThreshold: DEFAULT_APPETITE,
  autoTrashAfterDays: 30,
  // Pressed Keep on Lantern Books last spring, from the Promotions tab.
  keepEmails: ["news@lanternbooks.example"],
  keepDomains: ["lanternbooks.example"],
  // Pressed Block on BrightCart.
  blockDomains: ["brightcart.example"],
});

export const inbox: Email[] = [
  mail({
    id: "m01",
    from: "Tidewater Outfitters <offers@tidewater.example>",
    subject: "Final hours: 40% off rain shells",
    date: "2025-11-02T15:00:00Z",
    labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    listUnsubscribe: unsub("tidewater.example"),
  }),
  mail({
    id: "m02",
    from: "BrightCart <deals@mail.brightcart.example>",
    subject: "Your cart misses you",
    date: "2025-12-14T18:30:00Z",
    listUnsubscribe: unsub("brightcart.example"),
  }),
  mail({
    id: "m03",
    from: "Lantern Books <news@lanternbooks.example>",
    subject: "New in paperback this month",
    date: "2026-01-20T13:00:00Z",
    labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    listUnsubscribe: unsub("lanternbooks.example"),
  }),
  mail({
    id: "m04",
    from: "Harbor Bank <alerts@harborbank.example>",
    subject: "Large purchase alert: $1,240.00 at Copper Kettle",
    date: "2026-03-03T22:10:00Z",
    labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    bodyText: "A purchase over your alert limit was made on your card ending 4417. If this was not you, call us.",
  }),
  mail({
    id: "m05",
    from: "Jordan Lee <jordan@leehouse.example>",
    subject: "Saturday?",
    date: "2026-04-11T16:45:00Z",
    bodyText: "Still on for the farmers market? I can pick you up around 9.",
  }),
  mail({
    id: "m06",
    from: "Copper Kettle <noreply@copperkettle.example>",
    subject: "Your order #4471 has shipped",
    date: "2026-05-19T12:00:00Z",
    labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    bodyText: "Your Dutch oven is on its way. Track it with UPS 1Z999AA10123456784.",
  }),
  mail({
    id: "m07",
    from: "The Ledger Daily <digest@ledgerdaily.example>",
    subject: "Morning briefing: rates, rail strike, and a very large squash",
    date: "2026-06-08T11:00:00Z",
    listUnsubscribe: unsub("ledgerdaily.example"),
    bodyText: "Today in the newsletter: three stories in five minutes. To unsubscribe, use the link below.",
    bodyHtml: pad + '<a href="https://ledgerdaily.example/unsubscribe">unsubscribe</a>',
  }),
  mail({
    id: "m08",
    from: "Riverside Community Garden <hello@riversidegarden.example>",
    subject: "Fall planting day, October 18",
    date: "2026-07-15T14:20:00Z",
    listUnsubscribe: unsub("riversidegarden.example"),
    bodyText: "Bring gloves. We will split the garlic beds and plan the winter cover crop. Reply STOP to leave this newsletter.",
  }),
  mail({
    id: "m09",
    from: "Field Notes <hello@fieldnotes.example>",
    subject: "Issue 112: the case for slow software",
    date: "2026-08-22T09:00:00Z",
    listUnsubscribe: unsub("fieldnotes.example"),
    bodyText: "This week's newsletter is about software that waits for you.",
    bodyHtml: '<p>This week\'s issue.</p><a href="https://fieldnotes.example/unsubscribe">unsubscribe</a>',
  }),
  // Two earlier Field Notes issues Maya opened. Read mail is not backlog, but
  // it tells Gary she wants this sender.
  mail({
    id: "r01",
    from: "Field Notes <hello@fieldnotes.example>",
    subject: "Issue 110",
    date: "2026-08-08T09:00:00Z",
    labels: ["INBOX"],
  }),
  mail({
    id: "r02",
    from: "Field Notes <hello@fieldnotes.example>",
    subject: "Issue 111",
    date: "2026-08-15T09:00:00Z",
    labels: ["INBOX"],
  }),
  // A cold sales sequence: three steps from a person shaped address, sent
  // through a tool that adds a list header and a tracking pixel.
  ...[
    ["m10", "Quick question about your team", "2026-10-01T15:02:00Z"],
    ["m11", "Following up", "2026-10-03T15:02:00Z"],
    ["m12", "Should I close your file?", "2026-10-06T15:02:00Z"],
  ].map(([id, subject, date]) =>
    mail({
      id,
      from: "Dan Price <dan@growthloop.example>",
      subject,
      date,
      listUnsubscribe: "<https://t.growthloop.example/unsub?u=8812>",
      bodyText:
        "Hi Maya, teams like yours cut onboarding time in half with GrowthLoop. Want a free trial? " +
        "If this is not relevant, just reply opt out.",
      bodyHtml: '<p>Hi Maya,</p><img src="https://t.growthloop.example/tracking/open.gif">' +
        '<a href="https://t.growthloop.example/unsubscribe">unsubscribe</a>',
    }),
  ),
];

/** Mail that arrives after the backlog is done. */
export const later: Email[] = [
  mail({
    id: "m13",
    from: "Tidewater Outfitters <offers@tidewater.example>",
    subject: "Members weekend starts now",
    date: "2026-10-08T15:00:00Z",
    labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    listUnsubscribe: unsub("tidewater.example"),
  }),
  mail({
    id: "m14",
    from: "Jordan Lee <jordan@leehouse.example>",
    subject: "Re: Saturday?",
    date: "2026-10-08T16:00:00Z",
    bodyText: "Perfect, see you at 9.",
  }),
];
