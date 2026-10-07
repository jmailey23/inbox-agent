/**
 * The schema against a real Postgres (PGlite, in process). Policies are
 * checked as an ordinary role, because a superuser walks straight past RLS.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const ids = {
  maya: "00000000-0000-0000-0000-00000000000a",
  ravi: "00000000-0000-0000-0000-00000000000b",
  mayaRun: "00000000-0000-0000-0000-0000000000a1",
  raviRun: "00000000-0000-0000-0000-0000000000b1",
};

async function as(uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`reset role; set app.uid = '${uid ?? ""}'; set role app_user;`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role;");
  }
}

/** The server's write: an upsert on (user, message), as the engine does it. */
const decide = (user: string, run: string, msg: string, score: number, status = "pending") =>
  db.query(
    `insert into flagged_emails (user_id, gmail_email, gmail_message_id, sender, sender_domain, subject, spam_score, status, job_run_id)
     values ($1, 'inbox@example.com', $2, 'a@b.example', 'b.example', 's', $3, $4, $5)
     on conflict (user_id, gmail_message_id) do update set spam_score = excluded.spam_score, status = excluded.status`,
    [user, msg, score, status, run],
  );

before(async () => {
  await db.exec(readFileSync(new URL("../schema/001_inbox.sql", import.meta.url), "utf8"));
  await db.exec(`
    create role app_user nologin;
    grant usage on schema public to app_user;
    grant select, insert, update, delete on all tables in schema public to app_user;
    grant execute on all functions in schema public to app_user;

    insert into user_settings (user_id) values ('${ids.maya}'), ('${ids.ravi}');
    insert into job_runs (id, user_id, gmail_email, mode) values
      ('${ids.mayaRun}', '${ids.maya}', 'maya@example.com', 'clean'),
      ('${ids.raviRun}', '${ids.ravi}', 'ravi@example.com', 'clean');
  `);
  await decide(ids.maya, ids.mayaRun, "m07", 0.48);
  await decide(ids.maya, ids.mayaRun, "m01", 1, "resolved");
  await decide(ids.ravi, ids.raviRun, "r01", 0.41);
});

test("a repeated decision for the same message is one row", async () => {
  await decide(ids.maya, ids.mayaRun, "m07", 0.48);
  await decide(ids.maya, ids.mayaRun, "m07", 0.48);
  const n = await db.query<{ n: number }>("select count(*)::int as n from flagged_emails where gmail_message_id = 'm07'");
  assert.equal(n.rows[0].n, 1);
});

test("a user sees their own decisions, runs and settings, and nobody else's", async () => {
  const msgs = await as(ids.maya, "select gmail_message_id from flagged_emails order by 1");
  assert.deepEqual(msgs.rows.map((r: any) => r.gmail_message_id), ["m01", "m07"]);
  assert.equal((await as(ids.maya, "select * from job_runs")).rows.length, 1);
  assert.equal((await as(ids.maya, "select * from user_settings")).rows.length, 1);
});

test("nobody signed in sees nothing", async () => {
  assert.equal((await as(null, "select * from flagged_emails")).rows.length, 0);
  assert.equal((await as(null, "select * from job_runs")).rows.length, 0);
});

test("a user can resolve their own flag, and not someone else's", async () => {
  const mine = await as(ids.maya, "update flagged_emails set status = 'resolved', resolution = 'whitelist' where gmail_message_id = 'm07' returning id");
  assert.equal(mine.rows.length, 1);
  const theirs = await as(ids.maya, "update flagged_emails set status = 'resolved' where gmail_message_id = 'r01' returning id");
  assert.equal(theirs.rows.length, 0);
});

test("a user cannot hand a decision to another account", async () => {
  await assert.rejects(as(ids.maya, `update flagged_emails set user_id = '${ids.ravi}' where gmail_message_id = 'm01'`), /row-level security/);
});

test("decisions and runs are written by the server only", async () => {
  await assert.rejects(
    as(ids.maya, `insert into flagged_emails (user_id, gmail_email, gmail_message_id, sender, sender_domain, subject, spam_score)
                  values ('${ids.maya}', 'x', 'forged', 'a', 'b', 's', 0)`),
    /row-level security/,
  );
  await assert.rejects(as(ids.maya, `insert into job_runs (user_id, gmail_email) values ('${ids.maya}', 'x')`), /row-level security/);
  assert.equal((await as(ids.maya, "delete from flagged_emails returning id")).rows.length, 0, "and never deleted by a user");
});

test("a user sets their own dial, not someone else's", async () => {
  await as(ids.maya, `update user_settings set spam_score_threshold = 0.4 where user_id = '${ids.maya}'`);
  const other = await as(ids.maya, `update user_settings set spam_score_threshold = 0.3 where user_id = '${ids.ravi}' returning user_id`);
  assert.equal(other.rows.length, 0);
  const rows = await db.query<{ t: number }>("select spam_score_threshold as t from user_settings order by user_id");
  assert.deepEqual(rows.rows.map((r) => r.t), [0.4, 0.5]);
});

test("the trash sweep's index holds only eaten mail not yet trashed", async () => {
  const def = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'idx_flagged_trash_due'");
  assert.match(def.rows[0].indexdef, /trashed_at IS NULL/);
  assert.match(def.rows[0].indexdef, /resolution = ANY \(ARRAY\['unsubscribe'::text, 'blocked'::text\]\)/);
});
