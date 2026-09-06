# Arc modernization — next-session handoff

Continue the approved Arc/pi-subagents modernization in pi-nexus, starting with T3.

## Repository and state

- Worktree: `/home/bfirestone/devspace/personal/sentiolabs/pi-nexus/.worktrees/feat-new-pi-subagent`
- Branch: `feat/new-pi-subagent`
- Last verified implementation HEAD: `289f05ed3686a5d8b732c9451db9bf8dfeb51909`
- That implementation commit was pushed, clean, and up to date with origin. This handoff is a subsequent documentation change. Verify current state; never reset or overwrite intervening work.

Detailed handoff and historical evidence:

- `/home/bfirestone/.pi/agent/arc/planning-evidence/pinexus-13jb.07bvw8/HANDOFF.md`
- `/home/bfirestone/.pi/agent/arc/planning-evidence/pinexus-13jb.07bvw8/build-state.json`

## Delivery status

- Epic `pinexus-13jb.07bvw8` remains in progress.
- T0, T1, and T2 are closed. **Do not redo them.**
- T2: `pinexus-13jb.07bvw8.3`.
- Next: `pinexus-13jb.07bvw8.4` — **T3: Add the public pi-subagents RPC and native review adapter**.
- T3–T8 remain open. Read T3’s current canonical issue completely before planning execution.

### T2 acceptance

- Fresh parent verification passed **155 focused and 281 full tests**.
- Final independent code review: **PASS / DEVIATION_ACCEPT**.
- One committed-test instrumentation gap was accepted as non-blocking after stronger parent probes; the spec reviewer’s `ISSUES` result remains preserved.
- Historical failed native writer runs remain failed, not retroactively accepted.
- Actual Pi/provider/login canaries remain T4/T8 work.

### Open follow-ups

- `pinexus-13jb.03dhss`: strengthen preflight regression observations.
- `pinexus-13jb.048by1`: isolate disposable Git fixtures from global signing.
- `pinexus-13jb.0512nh`: make builder acceptance-report delivery unambiguous.
- Preserve existing `pinexus-13jb.02bdez` and the approved task hierarchy.

## First resolve the execution prerequisite

After the final review, both native child-launch entry points failed because the installed Pi package could not provide:

```text
@earendil-works/pi-server
@earendil-works/pi-server/unix
```

Recheck whether this persists in the new session. Diagnose using public documentation/APIs. Do not install/change runtime dependencies or settings without approval. Do not silently switch to foreground execution, external CLI agents, or another provider. The previous direct-Arc-CLI exception covered final administrative filing only.

## Execution discipline

1. Read `AGENTS.md` and relevant Arc skills; use `arc-build` for implementation.
2. The main agent orchestrates. Use one fresh native writer at a time, strictly within T3’s owned paths.
3. Preserve optional provider installation and public API boundaries.
4. Establish a reliable reporting contract before dispatch. Previous builders failed by nesting a native acceptance fence inside `ArcWorkerReport.summary`. Do not repeat conflicting final-output instructions, inject reports, disable gates, or make dummy edits.
5. Use fresh parent verification and independent snapshot-bound, read-only spec/code reviews.
6. T2’s seven-attempt bootstrap exception was task-specific. It does not change production limits or automatically carry into T3.
7. Full Arc tests currently require this command-local workaround:

   ```bash
   GIT_CONFIG_GLOBAL=/dev/null npm test --workspace @sentiolabs/pi-arc
   ```

   Do not change real repository signing settings.

## Judgment and completion

Avoid the repeated ceremonial repair/review loops of the previous session. Distinguish genuine correctness/safety blockers from minor test-strengthening opportunities, document justified dispositions, and preserve honest evidence.

Land accepted work with checks, issue updates, commit/push verification, and a concise handoff. Do not claim the entire modernization epic is complete when only one delivery slice has finished.
