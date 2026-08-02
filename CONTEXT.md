# WALAO

A personal AI information layer over WhatsApp, sold as a hosted SaaS. Merchants
sign up, pair their own WhatsApp number, enable specific groups, and receive
scheduled briefs of decisions, actions, dates, and open questions.

## Language

### Tenancy

**Account**:
One signup, identified by a verified email address — one human, one login, one
bill. The unit of ownership for every piece of data in the system and the
boundary that deletion and isolation are enforced on. Exists independently of
WhatsApp: an Account is real from signup, whether or not it has ever paired.
_Avoid_: Merchant, Tenant, Organisation, Workspace, Customer

**WhatsApp Session**:
The paired WhatsApp connection belonging to an Account. At most one per Account,
created when the Account completes a pairing scan.
_Avoid_: Connection, Device, Instance, Number

**Group**:
A WhatsApp group visible to an Account's WhatsApp Session. Off by default; only
an enabled Group is ever processed.
_Avoid_: Chat, Room, Conversation

**Group Member**:
A person in an enabled Group who does not hold an Account. Their messages are
processed on the Account holder's instruction and under their responsibility;
they are the data subject, never a user.
_Avoid_: Participant, Contact, Third party

**Attestation**:
A dated, versioned record of something an Account holder affirmed — that they
are responsible for a Group they enabled, that they accept WhatsApp ban risk at
pairing, that they authorise Tier 1 outbound, or that they accept the
data-processing terms. Stored with both the version and the exact wording that
was shown, so later edits to the copy cannot rewrite what was agreed.
_Avoid_: Consent, Acceptance, Agreement, T&C tick

**Processing Block**:
A reason WALAO must not process an Account's messages right now — paused,
unpaired, disconnected, unpaid, halted, or over its Plan's daily cap. An Account
has no single status; a Processing Block is the one question the pipeline asks.
_Avoid_: Suspended, Inactive, Disabled account

**Operator**:
A person who runs WALAO itself. May see an Account's metadata — counts, job
status, connection history, token usage — and may never read a message or
summary body, except for summaries from an Account that opted into quality
review.
_Avoid_: Admin, Staff, Support agent

### Product

**Summary**:
What one enabled Group produced over one scheduled window, condensed by AI into
highlights, decisions, action items, dates, and open questions in the Group's
chosen output language. Every claim in it carries references to the messages it
came from; a quiet window produces "nothing happened", never invented content.
_Avoid_: Digest, Recap, Report

**Item**:
One entry within a Summary. The unit an Account holder acts on — completes,
dismisses, confirms into a Reminder, or promotes into a Memory.
_Avoid_: Point, Bullet, Entry, Row

**Today Brief**:
One day's Summaries across all of an Account's Groups, merged and ranked into
needs action, decided, and worth noting, and delivered to the Account holder's
own WhatsApp chat with themselves. Duplicates across Groups collapse into one
Item that keeps every source. Never posted into a source Group.
_Avoid_: Daily digest, Roundup, Newsletter

**Coverage Gap**:
A stretch of time when an Account's WhatsApp Session was not connected, so
messages sent during it were never received. Any Summary or Today Brief
overlapping a Coverage Gap is flagged incomplete rather than presented as whole.
_Avoid_: Downtime, Outage, Missing window

**Reminder**:
An action Item the Account holder explicitly confirmed. Group text alone never
creates one, and confirming is the only path to existence.
_Avoid_: Task, To-do, Alert

**Memory**:
A durable fact an Account holder confirmed from a Summary's candidate — the kind
of thing that stays true after the conversation ends. Candidates expire unless
confirmed, so nothing becomes permanent on the model's judgement alone. Survives
Cancellation and belongs wholly to the Account holder.
_Avoid_: Fact, Knowledge base entry, Note

### Commerce

**Plan**:
The named tier an Account is on — Free or Pro — which fixes its caps on enabled
Groups, daily messages, and daily Credits.
_Avoid_: Tier, Package, Subscription level

**Credit**:
One AI-generated Group summary, counted against a Plan's daily cap. A unit of
measurement, never a balance: Credits are not bought, banked, or spent down.
_Avoid_: Token, Quota unit, Balance

**Trial**:
A dated window during which an Account gets Pro's caps without paying. It starts
when the Account pairs, lasts 14 days, requires no card, and is granted once per
WhatsApp number rather than once per Account.
_Avoid_: Free trial period, Demo, Evaluation

**Cancellation**:
An Account returning to the Free Plan. It is never a deletion event: Summaries,
Memories, and Reminders all survive, and enabled Groups stay enabled but blocked
until the Account fits within Free's caps again.
_Avoid_: Termination, Closure, Churn, Deletion
