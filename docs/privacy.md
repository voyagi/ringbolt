# Personal data in Ringbolt

What this product stores about people, why, for how long, who it goes to, and how to get it out.
Written for the operator who runs a Ringbolt deployment, because under the GDPR that operator is the
controller and Ringbolt is the thing they are answerable for.

It describes what the code does. Every window and every endpoint named here is in the source, and
`test/retention.test.ts` holds them to it.

## What is stored, and why

| What                                       | Where                                                    | Why it is there                                                                         |
| ------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A responder's name                         | `contacts`, copied into `action_runs.authorized_by`      | Ringbolt has to know who to call and the audit trail has to say who authorized a change |
| A responder's telephone number             | `contacts`                                               | It is what gets dialled                                                                 |
| The transcript of a call                   | `call_records.transcript`                                | It is the evidence behind a decision that changed a production system                   |
| The provider's summary of a call           | `call_records.summary`                                   | The same, in one sentence                                                               |
| The decision extracted from a call         | `call_records.structured_result`, `action_runs.decision` | It is the instruction that was carried out                                              |
| A responder's name inside timeline entries | `incident_events.message`                                | So the timeline reads as sentences rather than as identifiers                           |
| Alert payloads                             | `incidents.detail`, `incidents.title`                    | They are what the monitor sent, and they can carry anything the sender put in them      |

The last row is the one an operator has to think about rather than Ringbolt: if a monitor puts a
customer's email address in an alert title, Ringbolt stores it, because it stores what it was sent.
Nothing here inspects an alert for personal data, and no product could do that reliably.

## The lawful basis, as far as this code can carry it

Ringbolt is a tool an employer runs to reach its own on-call engineers. The basis for holding a
responder's name and number is normally the contract of employment or the operator's legitimate
interest in running a rotation, and for the transcript it is the legitimate interest in being able
to account for a change made to a production system.

That determination belongs to the operator, not to this document. What the product does is keep the
data minimal, keep it for a stated time, and make erasure work, which is what those bases require of
whoever relies on them.

## How long it is kept

Two windows, enforced by a sweep on the same cron as the reconciliation sweep, not by a promise.

- **Transcripts: `RETENTION_TRANSCRIPT_DAYS`, thirty days by default.** After that the words and the
  provider's summary are erased and the row records the date it happened. The row itself stays,
  because an action that changed a production system points at the call that authorized it.
- **Closed incidents: `RETENTION_INCIDENT_DAYS`, a year by default.** After that the incident is
  deleted outright with its events, its calls and its action runs.

An open incident is never deleted whatever its age, because it holds its fingerprint against a
unique index and freeing that would telephone somebody about a problem already in hand. An incident
still open after a year is a bug to look at.

The call ledger is not covered by either window and is not personal data: a call id, an incident id,
a timestamp and whether the call was real. It is what `/api/budget` reports as money spent, and a
figure that goes down cannot be reconciled against the provider's bill.

## Where it goes

**CALL-E** receives the number to dial and the incident facts in the task brief, and returns the
transcript and the extracted decision. It is a processor in the GDPR sense and the operator needs an
agreement with them like any other.

The brief carries **no name**. The responder's name is never sent, and neither is anything about who
else is in the rotation. Their number is, because it is what gets dialled.

**Their retention is theirs, and there is no way to shorten it.** The Developer API has no retention
setting and no delete on any path, which is not read off their documentation: it is what the
generated schema in their own SDK says. So Ringbolt keeps its own copy on its own window and cannot
promise anything about theirs.

**A backup copy leaves it too, if the operator switches one on.**
`.github/workflows/d1-backup.yml` exports the whole database on a daily schedule and keeps it as a
build artifact, so a copy survives losing the Cloudflare account. It is off unless
`D1_BACKUP_ENABLED` is set. When it is on, the dump is encrypted on the runner to an OpenPGP public
key before it becomes an artifact and the private half is never on GitHub, so the copy is ciphertext
to everybody who can reach it, and the artifact is deleted after thirty days. Those thirty days are
the caveat on the windows above and on erasure below: a transcript or a number can sit in an
encrypted backup for up to a month after the sweep or an erasure request took it out of the
database.

Nothing else leaves the deployment. There is no analytics, no error reporting service, no font CDN,
and no third party in the browser: the dashboard is served from the same Worker and the typefaces are
files in the bundle.

## Getting one person out of the record

Deleting a contact is not erasure and never was. Their name was copied into the audit trail when an
action ran, into the timeline every time they were called, and their voice is in the transcript of
every call they answered.

```bash
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" \
  https://your-deployment/api/config/contacts/con_.../erase
```

That one request:

1. Erases the words, the summary and the extracted decision of every call they answered, and records
   the date it did.
2. Replaces their name on every action they authorized with "a contact erased at their own request".
3. Removes their name from every timeline entry that had it written into a sentence.
4. Unlinks them from every incident.
5. Deletes the contact.

It comes back with a count of everything it changed, so the operator can answer the person who
asked. It refuses while they are still in a rota, because erasing somebody who is on call would
shorten the rotation without saying so: take them out of the rota first, which is one request, and
then erase.

Two things about it are decisions rather than accidents:

**The authority is replaced rather than emptied.** An action run with nobody on it reads as a
production change nobody authorized, which is a different claim and a false one. The record keeps
saying a person authorized it and that their name came out at their own request.

**Removing a name from free text can catch it inside a longer word.** A contact called Kim would
also take the "Kim" out of "Kimberley" in a timeline sentence. That is over-deletion, and
over-deletion is the safe direction for a request to be forgotten.

## Getting one person's data out for them

There is no export endpoint, and that is worth stating plainly rather than leaving somebody to look
for one. What a subject access request needs is in two places and both are readable through the
audit endpoint:

```bash
curl -H "authorization: Bearer $ADMIN_TOKEN" \
  https://your-deployment/api/audit/incidents
curl -H "authorization: Bearer $ADMIN_TOKEN" \
  https://your-deployment/api/audit/incidents/inc_...
```

The second gives the transcripts and the decisions for one incident. Assembling those into an answer
is manual today.

## Who can read it

Everything that says anything about a production estate or a person is behind `ADMIN_TOKEN`. That is
one shared token rather than accounts, for the reasons in `adr/0002-tenancy.md`, and its consequence
is that a Ringbolt deployment cannot tell two of its own operators apart.

Two exceptions, and neither publishes anything about anybody: `/health`, which says whether the
configuration parses, and `/api/session`, which says whether a token is wanted and how long this
deployment keeps things. Neither says what the token is.

**A public demo publishes everything it holds except telephone numbers.** That is what `DEMO_MODE`
is for, and it is why a demo deployment must have its own database. Names stay on a demo, because a
name is who authorized a production change and a demo with that column blanked would be a demo of a
different product. The names on the seeded demo are fictional.

## Where the deployment runs

Cloudflare Workers and D1. A D1 database's primary location is chosen when it is created, with
`wrangler d1 create ringbolt --location=weur`, and without that flag it lands near wherever the
create request came from. An operator serving people in the EU wants `weur` or `eeur`, and
Cloudflare documents the hint as a hint rather than a guarantee. It cannot be changed afterwards
without creating another database, so it is the first line of `deploying.md`.

CALL-E's own processing location is theirs to state, and an operator who needs that in writing
should get it from them before pointing a live deployment at them.
