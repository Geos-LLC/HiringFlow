# Pipeline Transitions v2

Rule-driven candidate stage advancement. Replaces V1's three-path engine
(configured stage triggers → completion-pair auto-advance → legacy
fallback) with a single mechanism: a `PipelineTransitionRule` row matches
an event and moves the candidate, or nothing happens.

V2 is opt-in per workspace and per pipeline, gated behind an env flag, and
ships with V1 still owning every existing pipeline. Nothing changes for
candidates or recruiters until you flip a flag.

---

## Architecture

```
                 system event              applyStageTrigger
  flow_completed ───────────────┐         ┌────────────────────────────────┐
  training_completed            │         │ isV2EnabledForSession?         │
  meeting_scheduled ────────────┼────────▶│   env flag &&                  │
  meeting_ended                 │         │   (workspace flag || pipeline) │
  recording_ready               │         └─────────┬──────────────────────┘
  ...                           │                   │
                                │              ┌────┴────┐
                                │              │         │
                                │              ▼         ▼
                                │           V1 path     V2 path
                                │           (legacy     (applyTransitionV2)
                                │            triggers,
                                │            completion-
                                │            pair,
                                │            fallback)
                                │                       │
                                │                       ▼
                                │           ┌───────────────────────┐
                                │           │ resolveTransition      │
                                │           │ - filter by pipeline   │
                                │           │ - filter by eventType  │
                                │           │ - filter fromStageId   │
                                │           │ - filter targetId      │
                                │           │ - sort by priority +   │
                                │           │   specificity          │
                                │           └───────────┬────────────┘
                                │                       │
                                │       ┌───────────────┴──────────────┐
                                │       │                              │
                                │       ▼ matched                      ▼ no match
                                │   ┌────────────────┐         ┌───────────────┐
                                │   │ furthest-wins  │         │ audit row     │
                                │   │ guard          │         │ v2:no_rule:*  │
                                │   │  (unless       │         │ no mutation   │
                                │   │   allowBackward│         └───────────────┘
                                │   │   = true)      │
                                │   └────────┬───────┘
                                │            │
                                │            ▼
                                │   ┌──────────────────────────────────┐
                                │   │ setPipelineStatus(toStageId)      │
                                │   │ create StageEntry row             │
                                │   │ reactivate stalled → active       │
                                │   │ cancelStageMismatchedQueued       │
                                │   │ fireStageEnteredAutomations       │
                                │   └──────────────────────────────────┘
```

### Key entities

- **`PipelineTransitionRule`** — `(workspaceId, pipelineId, fromStageId?,
  eventType, targetId?, toStageId, priority, allowBackward, enabled)`.
  Resolved at apply time. `fromStageId=null` / `targetId=null` are wildcards.
- **`StageEntry`** — one row per real stage entry. Pinned onto
  `AutomationExecution.stageEntryId` so re-entry produces a fresh entry
  and a fresh fan-out instead of dedup-blocking the second send.
- **`stage_entered` automation trigger** — fires when a candidate enters a
  specific (pipeline, stage). Requires both fields on the rule.

### Two opt-in flags + one env

V2 runs only when **all** of these are true for the candidate:

1. `process.env.PIPELINE_TRANSITIONS_V2 === 'true'` (Vercel env)
2. **Either** `Workspace.pipelineTransitionsV2Enabled` **or**
   `Pipeline.transitionsV2Enabled` is `true`

Any false → V1. The env flag is the global kill-switch; flipping it back
to `false` returns every candidate to V1 immediately.

---

## Rollout steps

Recommended order, smallest blast radius first:

1. **Confirm DB is migrated.** Schema was pushed additively (new tables +
   nullable columns + one unique-key swap). Verify:
   ```bash
   DATABASE_URL=... npx prisma migrate diff \
     --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma
   ```
   Should produce **no SQL** (DB in sync with schema).

2. **Deploy code with V2 OFF.** Set `PIPELINE_TRANSITIONS_V2=false` (or
   leave unset) in Vercel for both preview and prod. Code is inert: every
   `isV2EnabledForSession` returns false.

3. **Backfill rules for one test pipeline** (dry-run first):
   ```bash
   DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
     --pipeline=<pipelineId>
   ```
   Inspect the planned rules, then apply:
   ```bash
   DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
     --pipeline=<pipelineId> --apply
   ```

4. **Flip the env flag to `true`.** This unlocks V2 but does not enable
   it for any pipeline yet (DB flags are still `false`).

5. **Enable V2 for the one test pipeline.** Easiest is the Pipelines UI
   toggle. SQL equivalent:
   ```sql
   UPDATE pipelines SET transitions_v2_enabled = true WHERE id = '<pipelineId>';
   ```

6. **Smoke a real candidate** through the test pipeline. Watch the
   `stage_entries` and `pipeline_status_change` tables (queries in
   Troubleshooting below) to confirm transitions fired.

7. **Expand to more pipelines** by repeating steps 3 + 5. There is no
   rush to move every pipeline at once — V1 and V2 coexist permanently as
   long as both flag systems are independent.

---

## Backfill commands

The script never enables V2 unless asked, and refuses a global apply
without `--all`.

```bash
# Dry-run (default) — read-only, prints the plan.
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts

# Scope to one workspace.
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
  --workspace=<workspaceId>

# Scope to one pipeline.
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
  --pipeline=<pipelineId>

# Apply (write rules, leave V2 OFF for that pipeline).
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
  --pipeline=<pipelineId> --apply

# Apply AND flip the pipeline's V2 toggle ON
# (only flips if the pipeline has >=1 rule after the run — pipelines with
#  zero V1 triggers stay safely on V1).
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
  --pipeline=<pipelineId> --apply --enable-v2

# Workspace-wide.
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
  --workspace=<workspaceId> --apply --enable-v2

# Global apply requires --all.
DATABASE_URL=... npx tsx scripts/backfill-pipeline-transitions-v2.ts \
  --all --apply
```

Idempotent: the dedupe key is `(pipelineId, toStageId, eventType,
targetId, fromStageId)`. Re-running with the same args is a no-op for
rows that already exist.

---

## Enable / disable

### Enable for one pipeline

UI (preferred):
- Dashboard → Pipelines → flip the "Rule-driven transitions (V2)" toggle.

SQL:
```sql
UPDATE pipelines SET transitions_v2_enabled = true WHERE id = '<pipelineId>';
```

### Enable for a whole workspace

```sql
UPDATE workspaces SET pipeline_transitions_v2_enabled = true WHERE id = '<workspaceId>';
```

### Disable everything immediately

Set `PIPELINE_TRANSITIONS_V2=false` (or delete the var) in Vercel and
redeploy. This is the fastest path back to V1 — no DB writes required,
every candidate falls back to V1 the instant the new env propagates.

DB-level flags can be left as-is; they're harmless without the env flag.

### Disable one pipeline

```sql
UPDATE pipelines SET transitions_v2_enabled = false WHERE id = '<pipelineId>';
```

---

## Troubleshooting

### Verify a transition fired

```sql
SELECT entered_at, stage_id, previous_stage_id, source_event_type, transition_rule_id
FROM stage_entries
WHERE session_id = '<sessionId>'
ORDER BY entered_at DESC
LIMIT 5;
```

For no-rule / blocked-backward outcomes (where no `StageEntry` is
created) the audit row is in `pipeline_status_change`:

```sql
SELECT created_at, from_status, to_status, source, metadata
FROM pipeline_status_change
WHERE session_id = '<sessionId>' AND source LIKE 'v2:%'
ORDER BY created_at DESC;
```

Source tags:
- `v2:auto:<event>` — rule matched, candidate moved
- `v2:no_rule:<event>` — no rule matched, no mutation
- `v2:transition_blocked_backward:<event>` — rule matched but would have
  moved backward and `allowBackward=false`

### Verify a `stage_entered` automation fired

```sql
SELECT ae.id, ae.status, ae.channel, ae.created_at, ae.stage_entry_id, ar.name
FROM automation_executions ae
JOIN automation_rules ar ON ar.id = ae.automation_rule_id
WHERE ae.session_id = '<sessionId>'
  AND ar.trigger_type = 'stage_entered'
ORDER BY ae.created_at DESC;
```

`stage_entry_id` MUST be non-null on a real `stage_entered` send. A null
value on what should be a V2 send means the StageEntry pin was lost (most
likely a QStash callback rehydration bug).

### Candidate is not moving

In order, check:

1. **Is V2 actually applying to this candidate?**
   ```sql
   SELECT w.pipeline_transitions_v2_enabled AS ws_flag,
          p.transitions_v2_enabled AS pipeline_flag,
          p.name AS pipeline_name
   FROM sessions s
   JOIN workspaces w ON w.id = s.workspace_id
   JOIN flows f ON f.id = s.flow_id
   LEFT JOIN pipelines p ON p.id = COALESCE(f.pipeline_id, (
     SELECT id FROM pipelines WHERE workspace_id = w.id AND is_default LIMIT 1
   ))
   WHERE s.id = '<sessionId>';
   ```
   Plus `PIPELINE_TRANSITIONS_V2` in Vercel env. Any falsy → V1 owns the move.

2. **Did the event reach `applyStageTrigger`?** Grep prod logs (LogHub /
   Grafana):
   ```logql
   {service_name="hiringflow"} |= "<sessionId>"
   ```
   Look for `[funnel-stage-runtime]` lines or the upstream caller
   (`fireMeetingScheduledAutomations`, etc.).

3. **Did V2 find a matching rule?** Check the audit (query above). If
   the most recent row is `v2:no_rule:*`, add a `PipelineTransitionRule`
   for that event in the Stages drawer (or via the script).

4. **No `v2:*` rows at all?** V2 didn't apply (see step 1) or the
   upstream code path bypassed `applyStageTrigger`. Most event fire
   sites already go through it; investigate the specific code path.

5. **Stage drift / halt switch?**
   ```sql
   SELECT pipeline_status, status, automations_halted_at FROM sessions WHERE id = '<sessionId>';
   ```
   If `automations_halted_at` is set, the candidate is halted independently
   of V1/V2 (stalled / manual halt / compliance hold).

### `stage_entered` automation fires twice on the same entry

It shouldn't. The unique constraint `[stepId, sessionId, channel,
stageEntryId]` and the guard's idempotency lookup both scope by
`stageEntryId`, so a duplicate dispatch against the same StageEntry
is rejected as `skipped_duplicate`. If you see two `sent` rows for the
same `stage_entry_id` value, treat it as a regression and check whether
the resolver is somehow creating duplicate `StageEntry` rows for one
real entry.

### Wildcard rule winning when a specific rule should

Resolution order in [src/lib/pipeline-transitions.ts](../src/lib/pipeline-transitions.ts):

1. Higher `priority` wins.
2. Tie → more-specific wins (non-null `fromStageId` beats null;
   non-null `targetId` beats null; both non-null beats either single).
3. Tie → oldest `createdAt` wins (stable ordering).

If a wildcard is winning, either bump the specific rule's priority or
delete the wildcard for that event.

### Backward rule blocked

Expected when `allowBackward=false`. Audit shows
`v2:transition_blocked_backward:<event>`. To allow: edit the rule and
flip `allowBackward=true` (UI toggle or SQL).

---

## File map

- [src/lib/pipeline-transitions.ts](../src/lib/pipeline-transitions.ts) — resolver, V2 flag checks, apply function
- [src/lib/funnel-stage-runtime.ts](../src/lib/funnel-stage-runtime.ts) — V1/V2 dispatch in `applyStageTrigger`
- [src/lib/automation.ts](../src/lib/automation.ts) — `fireStageEnteredAutomations`, `stageEntryId` threading
- [src/lib/automation-guard.ts](../src/lib/automation-guard.ts) — idempotency scoped by `stageEntryId`
- [src/app/api/pipelines/[id]/transition-rules/](../src/app/api/pipelines/[id]/transition-rules/) — CRUD endpoints
- [src/app/dashboard/candidates/_StageSettingsDrawer.tsx](../src/app/dashboard/candidates/_StageSettingsDrawer.tsx) — V2 editor inside the existing stage drawer
- [scripts/backfill-pipeline-transitions-v2.ts](../scripts/backfill-pipeline-transitions-v2.ts) — migration tool
- [src/lib/__tests__/pipeline-transitions.test.ts](../src/lib/__tests__/pipeline-transitions.test.ts) — integration tests
