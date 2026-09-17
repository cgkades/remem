# Episodic Supersession Review

`remem supersession-candidates --project <PROJECT_ID>` lists a bounded set of
potentially obsolete episodes. It is a review aid, not a deletion command.

## Eligibility

A suggestion exists only when all of the following are true:

- The older and newer episodes belong to the requested provider and project.
- Both episodes have explicit links to the same existing project-scoped entity.
- The newer episode has an `approved` or `promoted` deterministic candidate
  whose type is `decision`; rejected and pending candidates never qualify.
- The newer event timestamp is later than the older event timestamp.

The command returns only evidence IDs, one deterministic shared entity ID,
timestamps, and the
fixed `newer-decision-shares-entity` reason. It does not emit episode text,
candidate bodies, model-generated rationales, or a claim that the newer
decision actually supersedes anything.

Raw evidence events remain raw transport records; TASK-061 does not turn a
host event kind into a decision. The required decision signal is an existing
deterministic candidate type, and later reviewed extraction/linking work is
responsible for adding evidence-to-entity links. No free-text or model-driven
scan can add a candidate to this list.

## Human Review

Review a proposed old evidence ID before deletion:

```sh
remem forget <EVIDENCE_ID> --project <PROJECT_ID>
```

The TASK-013 preview and interactive confirmation remain mandatory. Rejecting,
ignoring, or merely listing a suggestion changes nothing. A confirmed forget
still removes only the scoped episode and its direct candidate rows; semantic
memory preservation and backup/restore constraints are documented in
[`privacy-forget.md`](privacy-forget.md).
