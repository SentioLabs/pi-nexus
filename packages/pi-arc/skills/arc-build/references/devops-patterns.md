# DevOps Patterns — Dry-Run, Verify, Rollback Idioms

A cheatsheet for the `devops-builder` agent's PLAN → SAFEGUARD → APPLY → VERIFY → GATE loop.
Map each phase to the task's actual tooling. These are idioms, not a mandate — adapt to the
project's conventions, versions, and wrappers (Makefiles, `task`, `just`, CI jobs).

The columns deliberately line up with the agent's loop:

| Phase | What you're proving |
|-------|---------------------|
| PLAN | "Here is exactly what will change" (no surprises) |
| SAFEGUARD | "Here is how I undo it" (rollback exists) |
| APPLY | "Change it, but staged" (bounded blast radius) |
| VERIFY | "It reached the desired state" (live assertion) |
| GATE | "A second preview is clean" (idempotent + reversible) |

## Kubernetes (kubectl)

| Phase | Command idiom |
|-------|---------------|
| Confirm target | `kubectl config current-context`, `kubectl config view --minify -o jsonpath='{..namespace}'` |
| PLAN | `kubectl diff -f manifest.yaml` (shows server-side diff before apply) |
| SAFEGUARD | `kubectl get <kind> <name> -n <ns> -o yaml > backup-<name>.yaml`; record image/replicas |
| APPLY (staged) | drain one node at a time: `kubectl cordon <node>` → `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` → upgrade → `kubectl uncordon <node>`. For Deployments, rely on `RollingUpdate` `maxUnavailable`/`maxSurge` and watch. |
| VERIFY | `kubectl get nodes -o wide` (version + `Ready`); `kubectl rollout status deploy/<name> -n <ns>`; `kubectl get pods -n <ns>` (no `CrashLoopBackOff`/`ImagePullBackOff`); `kubectl get events --sort-by=.lastTimestamp` |
| GATE (idempotency) | `kubectl diff -f manifest.yaml` again → expect empty |
| ROLLBACK | `kubectl rollout undo deploy/<name> -n <ns>`; or `kubectl apply -f backup-<name>.yaml`; re-`uncordon` any nodes left cordoned |

**Cluster/control-plane upgrades** (kubeadm/EKS/GKE/AKS): upgrade control plane first, then node pools one at a time; never upgrade the data plane ahead of the control plane; respect the version-skew policy (kubelet may trail the API server by N minor versions but never lead it). Verify with `kubectl version` and node `KubeletVersion` before declaring done.

## Helm

| Phase | Command idiom |
|-------|---------------|
| PLAN | `helm upgrade <release> <chart> --dry-run --debug -f values.yaml` (and `helm diff upgrade …` if the diff plugin is installed) |
| SAFEGUARD | `helm history <release>` — record the current revision number to roll back to; `helm get values <release> > backup-values.yaml` |
| APPLY | `helm upgrade <release> <chart> -f values.yaml --atomic --timeout 5m` (`--atomic` auto-rolls-back a failed upgrade) |
| VERIFY | `helm status <release>`; `helm test <release>` if tests are defined; then the kubectl health checks above |
| GATE (idempotency) | run `helm diff upgrade <release> <chart> -f values.yaml` and expect an empty diff; if the plugin is unavailable, compare `helm template` output with `helm get manifest` |
| ROLLBACK | `helm rollback <release> <previous-revision>` |

## Terraform / OpenTofu

| Phase | Command idiom |
|-------|---------------|
| Confirm target | `terraform workspace show`; confirm the backend/account in the active credentials |
| PLAN | `terraform plan -out=tfplan` — **read it**; confirm the create/update/**destroy** counts match intent. An unexpected `destroy` is a STOP condition. |
| SAFEGUARD | back up state: `terraform state pull > backup.tfstate`; for remote state, confirm versioning is on |
| APPLY | `terraform apply tfplan` (apply the saved plan, not a fresh one — guarantees you apply exactly what you reviewed) |
| VERIFY | `terraform plan` → expect "No changes"; check the real resources via the cloud CLI/provider |
| GATE (idempotency) | the post-apply `terraform plan` showing **no drift** IS the idempotency check |
| ROLLBACK | re-apply the prior config/state (`git revert` the IaC change then `apply`), or `terraform state push backup.tfstate` for state-level recovery. Note: not all resource changes are cleanly reversible — flag destroys in SAFEGUARD. |

## Ansible

| Phase | Command idiom |
|-------|---------------|
| PLAN | `ansible-playbook play.yml --check --diff` (check mode = dry run; `--diff` shows file/template changes) |
| SAFEGUARD | back up changed files/configs on targets; note current package versions / service states |
| APPLY (staged) | `--limit <canary-host>` first, verify, then widen; use `serial:` in the play for batched rollout |
| VERIFY | re-run with `--check --diff` → expect no changes (idempotent); plus task-specific health checks |
| GATE (idempotency) | a second real run reports `changed=0` — Ansible's built-in convergence signal |
| ROLLBACK | a reverse playbook, or restore the backed-up configs and restart services |

## Cloud CLIs (AWS / GCP / Azure)

- **Confirm target first:** `aws sts get-caller-identity`, `gcloud config list`, `az account show`. Wrong-account is the highest-cost mistake.
- **PLAN:** prefer the provider's preview — CloudFormation `change-sets`, `gcloud … --dry-run` where supported, `az deployment … what-if`. If a raw CLI mutation has no provider-supported preview or change set, STOP and require explicit authorization plus a verified recovery procedure; describing current state alone is not a safe preview.
- **SAFEGUARD:** snapshot before destructive changes (EBS/RDS snapshots, disk images); record current values of anything you're changing.
- **VERIFY:** `describe`/`get` the resource and assert the new state; check it's not just created but healthy/available.
- **ROLLBACK:** restore from snapshot, or re-apply prior config. Many cloud deletes are irreversible — those are STOP-and-confirm conditions, not autonomous actions.

## Database migrations

The other big "can't unit-test, must verify live, must be reversible" class. The cardinal rule: **never couple a schema change to the app deploy that needs it.** Use **expand/contract** (a.k.a. parallel change) so the schema is compatible with both the old and new app versions at every step — that's what makes the rollout and the rollback safe.

Expand/contract in three deploys:

1. **Expand** — add the new structure, backward-compatible only. Add nullable columns / new tables / new indexes. Do NOT drop or rename anything yet. Old code keeps working untouched.
2. **Migrate + dual-write** — deploy app code that writes **both** old and new shapes and reads the new one (falling back to old). Backfill historical rows in batches. The system is correct whether or not the backfill has finished.
3. **Contract** — once the new shape is fully populated and nothing reads the old one, drop the old columns/tables. This is the only destructive step, and it's now safe because nothing depends on what's being dropped.

| Phase | What to do |
|-------|-----------|
| Confirm target | Confirm the DB host/name in the active connection string; confirm you're not pointed at prod by accident (`SELECT current_database()`, check the host). |
| PLAN | Generate and **read** the migration SQL/DDL before running it (`migrate ... --dry-run` / framework's "show SQL" / `EXPLAIN` the backfill). Confirm it's expand-only at this step — no drops/renames sneaking in. Check lock impact (see below). |
| SAFEGUARD | Take a backup/snapshot (`pg_dump`, RDS snapshot) before any schema change. Confirm the migration tool records a **down/rollback** migration, and that it actually reverses the up. For the contract step, confirm the dropped objects are captured in the backup. |
| APPLY (staged) | Run the migration, then deploy app code — never in one irreversible step. Backfill in **batches** (`LIMIT`/keyset pagination), not one giant `UPDATE`, to avoid long locks and replication lag. Watch lag between batches. |
| VERIFY | Row counts/parity between old and new shape; new constraints hold; `EXPLAIN` shows the new index is used; app health green on the new code path; replication lag returned to baseline. |
| GATE (idempotency) | Re-running the migration is a no-op (tool reports "already applied" / version table current). The backfill, re-run, changes 0 rows. |
| ROLLBACK | Before contract: redeploy the previous app version (schema is still backward-compatible — that's the whole point) and/or run the down migration. After contract: the drop is destructive, so rollback is restore-from-backup or a forward-fix migration — flag this explicitly in `## Rollback`, like any irreversible step. |

Lock-safety reminders (Postgres-flavored, adapt per engine):

- **Build indexes concurrently** (`CREATE INDEX CONCURRENTLY`) so you don't hold a write lock on a hot table.
- **Adding a `NOT NULL` column with a default** can rewrite the whole table on older engines — prefer add-nullable → backfill → add constraint `NOT VALID` → `VALIDATE CONSTRAINT`.
- **Renames and type changes are not backward-compatible** — model them as add-new + dual-write + drop-old, never an in-place rename.
- A migration that takes a lock and then waits behind a long query can **queue every subsequent query behind it** — set a `lock_timeout` so it fails fast instead of stalling the app.

NoSQL / schemaless stores have no DDL but the same shape applies: the schema lives in the application, so expand/contract means *deploy code that tolerates both the old and new document shape*, backfill, then remove the old-shape handling.

## CI/CD pipelines

- **PLAN:** lint/validate the pipeline config (`gh workflow view`, `circleci config validate`, `gitlab-ci-lint`); for changes to a running pipeline, dry-run on a branch first.
- **SAFEGUARD:** the prior pipeline config is in git — the rollback is `git revert`.
- **APPLY/VERIFY:** trigger a run on a non-protected branch, watch it go green, *then* merge. Don't validate a pipeline change only by reading the YAML.
- **VERIFY:** the run completes successfully end-to-end; artifacts/deploys land where expected.

## Universal safety reminders

- A tool reporting "success" means the API accepted the request — **not** that the system converged. Always assert observed live state.
- "Exists" ≠ "Ready" ≠ "serving". Give rollouts time to settle and re-check.
- Stage everything that can be staged. The blast radius of a staged change is one unit; of a big-bang, the whole fleet.
- If a second dry-run still wants to change things, the apply didn't converge — that's a finding, not noise.
- Never log secrets. Redact tokens/kubeconfigs/credentials in evidence and reports.
