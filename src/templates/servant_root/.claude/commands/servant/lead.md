---
description: Report where the whole initiative stands — in flight, ready, blocked, stale — and redirect a running session from there.
argument-hint: "[optional: a question about the initiative, or an instruction to pass on]"
---

# /servant:lead

Answer "where is this whole thing up to?" in one view, and act on the answer without changing tools.

The information already exists and is scattered across four places: the hub knows the tickets and
how they block each other, the **Claims** know who is carrying what, the session registry knows who
is still alive, and the transcripts know what each session has been doing. Reading them separately
means holding four things in your head; this joins them.

**It is a skill, not a session type.** Any session runs it and leads for that turn — including a
Summons, which is what makes talking about the initiative in general work. There is no privileged
coordinator tab. The cost is deliberate: nothing watches continuously, so a dead session goes
unnoticed until somebody asks. This is the asking.

## 1. Orient

- **Workspace**: infer from cwd (`~/.ai_servant/workspaces/<name>/…`).
- **Hub + label**: `docs/agents/issue-tracker.md`.
- If `$ARGUMENTS` is a question, answer it from the join below rather than reporting everything.
  If it is an instruction for a running session, report first, then go to step 4.

## 2. Read the join

```bash
servant tasks --frontier --ws <name> --json
servant sessions --json
```

The first is the join itself — tickets, blocking edges in all three forms, Claims, and liveness.
The second says what is running that carries no ticket (your hands, anything started by hand) and
whether each session is idle or busy.

| bucket | means |
|---|---|
| `ready[]` | unblocked, nobody holds the Claim |
| `stale[]` | unblocked, but the session holding the Claim is **gone** — reclaimable |
| `inFlight[]` | a session is on it; `claim.session` names which, `claim.since` when |
| `blocked[]` | `blockedBy` names the open tickets it waits on |

`livenessKnown: false` means the machine could not be asked who is alive. Everything claimed is
then reported as in flight, because a ticket you cannot prove is free is not free. **Say that you
could not check** — do not report "nothing is stale" as though you had looked.

Both commands read files and exit. Never ask a session what it is doing to fill this in: that costs
it a whole turn and is billed like a typed prompt, and the answer is already on disk
(workspace ADR-0010, decision 5). If you want to know what a session actually *did*, read its
transcript — `servant sessions --json` gives you the handle.

## 3. Report

Lead with what is moving, then what is stuck. Keep it to a screen; this is a status read, not an
audit.

> **In flight (2)**
> - **#25** Claims consumed — `ai-servant-t26`, since 21:06 · busy
> - **#31** dashboard panel — `ai-servant-t31`, since 09:14 · idle for a while
>
> **Stale (1)** — claimed by a session that is gone, reclaimable
> - **#22** worktree cleanup — `ai-servant-t22` is no longer running
>
> **Ready (3)**: #1, #18, #19
> **Blocked (1)**: #27 waits on #25
>
> Nothing has moved on #31 in a while — want me to ask it, or take it over?

Call out the two things only this join can surface: a **stale claim** (work that looks owned and
is not), and a **blocked ticket whose blocker just closed** (work that is now free and looks busy).

## 4. Redirect from here

Noticing something is off and correcting it should be one gesture, not two. You are a Claude
session, so you can message another one directly — under exactly the rules voice steering follows
(ADR-0010, decisions 8 and 9):

- **Only sessions in `inFlight[]`, plus this workspace's own hands session.** A session holding no
  Claim on this workspace's tickets is not addressable, and a session in another workspace or
  another project is not reachable at all. Do not work around this by name.
- **Say what it is for, and let it land at a safe point.** Include: *"Take this up at your next
  safe point — finish the edit or command you are part-way through first. Never leave a file
  half-written to act on this."* A session that pivots mid-edit leaves the tree in a state nobody
  asked for.
- **A redirect needs no confirmation.** Sessions run in auto mode and their own permission prompts
  are the real gate. Just say what you passed on, and to whom.
- **Stopping or abandoning a session does.** It destroys work already done and nothing downstream
  catches it. Say out loud what you are about to stop and that work may be lost, get a plain yes,
  and only then send it.
- **Report delivery honestly.** Sending proves the instruction was *queued*, not that it was
  applied — the session takes it up later, on purpose. Say it has been passed on. Do not say it has
  been done, and do not say it landed if the send failed.
- **An instruction that changes what *done* means goes on the ticket**, because that outlives the
  session. A plain course correction does not — the transcripts already have it twice.

To reclaim a stale claim rather than redirect, hand the ticket to a new session:

```bash
servant claim <N> --session <workspace>-t<N>
servant spawn -w <workspace> --prompt "…"
```

`servant spawn` writes no Claim of its own, so the `servant claim` line is what actually transfers
it. For a full fan-out over everything dispatchable, use `/servant:handoff` instead — that is the
skill that writes a handoff doc and spawns one session per ready ticket.

## Notes

- Reading is free and silent; **redirecting and reclaiming change things** — the rules above are
  what keeps that safe.
- If nothing is running and nothing is ready, say so plainly and stop. Don't invent work.
- This reports and redirects; it does not implement. Ticket-scale work goes to `/servant:handoff`.
