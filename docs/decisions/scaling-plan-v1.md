# Scaling Plan v1

## Decision

Make durable state container-independent before scaling replicas or splitting workers.

The first implementation move is not Redis, not replicas, and not a worker split. The first move is to make Postgres the durable source of truth for product state while treating local disk as cache/scratch. Once that is true, web replicas, worker services, Upstash, SQS, or a customer-owned cloud can be swapped in with less regret.

## Socratic Check

If one Railway container disappears, what must survive?

- users, runs, events, wiki artifacts, capability settings, final answers, diffs, and audit history.

If a second web replica appears, what cannot remain process-local?

- active run truth, cancellation, durable run state, capability configuration, and user-visible artifacts.

If BYOC matters later, what should not leak into core product logic?

- Railway volumes, Upstash-specific queue calls, Cloudflare-specific identity shape, or assumptions that local filesystem is durable.

## Current Shape

```text
+-----------------------------+
| Postgres                    |
| postgres-volume             |
+--------------+--------------+
               |
+--------------v--------------+
| selfless-fulfillment         |
| rlmwiki.deepascii.com        |
|                              |
| One web container            |
| - UI/API/auth/SSE            |
| - agent execution            |
| - JCODE subprocesses         |
| - git clones                 |
| - active run counters in RAM |
| - /data durable-ish storage  |
|                              |
| selfless-fulfillment-volume  |
+------------------------------+
```

This is acceptable for MVP, but it couples fast web traffic to slow agent execution and couples product state to one mounted volume.

## Target Shape

```text
Browser
  |
  v
Ingress/Auth
  |
  v
+------------------------+
| Web/API Service        |
| stateless fast lane    |
| - serve UI             |
| - auth/session         |
| - create runs/jobs     |
| - stream/read events   |
+-----------+------------+
            |
            v
+------------------------+       +------------------------+
| Queue Adapter          |       | Database Adapter       |
| - Postgres queue       |       | - Postgres             |
| - Redis/Upstash        |       | - RDS/Cloud SQL        |
| - SQS/PubSub/RabbitMQ  |       | - customer Postgres    |
+-----------+------------+       +-----------+------------+
            |                                ^
            v                                |
+------------------------+                   |
| Worker Service         |-------------------+
| slow lane              |
| - claim jobs           |
| - run JCODE/git        |
| - append events        |
| - complete/cancel      |
+------------------------+
```

Railway, Upstash, Cloudflare, and `/data` are deployment-profile details. They should not define the product architecture.

## Cost-First Phases

### Phase 1: Durable State First

Keep one Railway web service. Make Postgres authoritative for product state where it already fits. Keep filesystem writes as compatibility cache only.

Immediate scope:

- confirm `DATABASE_URL` drives product persistence in production;
- store wiki artifacts in `ProductStore`;
- store capability settings in `ProductStore` when Postgres is available;
- keep local files as cache/fallback;
- improve health output so operators can see whether the app is running file or Postgres persistence.

### Phase 2: Job Boundary

Introduce a `JobQueue` interface without immediately choosing a vendor-specific queue.

Start with Postgres-backed queue semantics if volume is still being removed. Use Upstash only when it reduces measured pain.

```text
interface JobQueue {
  enqueue(job)
  claimNext(workerId)
  heartbeat(jobId)
  cancel(jobId)
  complete(jobId)
  fail(jobId)
}
```

### Phase 3: Worker Split

Split Railway into:

- `web`: UI/API/auth/SSE, no required volume;
- `worker`: JCODE/git/agent execution, controlled concurrency.

Scale the lane that is hot. Do not scale expensive worker compute just because web traffic increases.

### Phase 2.5: Short-Lived BYOK Secret Grants

Phase 3 cannot safely execute user jobs unless workers can access BYOK credentials
without storing raw provider keys in product state.

Add a secret-grant boundary before activating workers:

```text
Browser BYOK keys
  -> Web/API validates request
  -> encrypted short-lived SecretGrant
  -> queued job references secretGrantId
  -> worker decrypts grant during execution only
  -> grant is revoked/expired after terminal job state
```

Guardrails:

- never store raw provider keys in runs, events, job payloads, or artifacts;
- require an operator-provided encryption key for worker execution;
- keep grants short-lived and owner-scoped;
- fall back to inline execution if secret grants are unavailable;
- keep the interface provider-neutral so BYOC can use Postgres, KMS, Vault, or
  cloud secret managers later.

### Phase 4: Optional Queue Upgrade

Add Upstash/Redis/BullMQ as another `JobQueue` implementation if Postgres queue polling or retry complexity becomes expensive.

Use Redis for coordination, not product memory:

- good: pending jobs, claims, short locks, rate limits, coarse notifications;
- bad: sole storage for final answers, wiki artifacts, audit history, or all tiny stream deltas.

## BYOC Guardrails

Core code should depend on contracts:

- `AuthIdentity`, not Cloudflare headers everywhere;
- `ProductStore`, not direct Railway volume paths;
- `JobQueue`, not direct Upstash calls everywhere;
- object/file storage adapter if large artifacts outgrow Postgres JSON;
- worker runtime adapter if JCODE execution moves to customer runners.

Deployment profiles can then vary:

```text
MVP Railway:
  Railway Web + Railway Postgres + optional Upstash

AWS BYOC:
  ECS/Fargate or EKS + RDS Postgres + SQS/ElastiCache + S3

GCP BYOC:
  Cloud Run/GKE + Cloud SQL + Pub/Sub/Memorystore + GCS

Self-host:
  Docker/Kubernetes + Postgres + optional Redis + S3-compatible storage
```

## v1 Implementation Boundary

This v1 intentionally does not split workers or add Redis. It hardens the state boundary first:

```text
Before:
  capability settings -> /data/users/{user}/config/capabilities.json

After:
  capability settings -> ProductStore artifact when available
  filesystem copy     -> local cache/fallback for existing capability code
```

That is a small enough change to verify now and a strong enough move to make the next architecture step safer.

## Phase 2 Implementation Boundary

Phase 2 adds the queue boundary without adding a new paid service yet:

```text
Before Phase 2:
  detached run -> in-process background task
  persisted events/results -> Postgres

After Phase 2:
  detached run -> JobQueue.enqueue(...)
               -> JobQueue.claim(...)
               -> in-process execution bridge
               -> JobQueue.complete/fail/cancel
  persisted events/results -> Postgres
```

The first queue driver is Postgres because it is already paid for, already needed
for durable state, and easy to replace behind `JobQueue`.

Railway still shows only two boxes:

```text
Postgres
  - product runs/events/artifacts
  - capability settings
  - rlm_jobs queue table

selfless-fulfillment
  - UI/API/Auth/SSE
  - current inline agent execution
  - optional detached bridge when RLM_WIKI_RUN_MODE=detached
  - /data cache/scratch/fallback
```

The visible topology does not change until Phase 3, when a separate worker
service starts claiming jobs. That is intentional: Phase 2 proves the contract
without committing to Upstash, SQS, Pub/Sub, or a second Railway service.

## Phase 2.5 Implementation Boundary

Phase 2.5 adds a secure handoff for BYOK before workers are activated:

```text
Before Phase 2.5:
  queued job payload -> run input only
  worker credential story -> missing for BYOK

After Phase 2.5:
  queued job payload -> run input + secretGrantId
  provider keys      -> encrypted SecretGrant with TTL
  worker             -> decrypts grant only while executing claimed job
```

`RLM_WIKI_SECRET_GRANT_KEY` becomes a required worker-mode deploy secret. Without
it, the app can still run `inline` or the in-process `detached` bridge, but it
must not hand jobs to an external worker.

## Phase 3 Implementation Boundary

Phase 3 should start as a reversible worker lane, not an all-at-once rewrite:

```text
Web service:
  - creates run
  - creates short-lived secret grant
  - enqueues supported job payload
  - streams persisted run events

Worker service:
  - claimNext(...)
  - decrypt secret grant
  - execute supported job kind
  - append events/results
  - complete/fail/cancel job
```

The first production-safe worker target should be Code Anything because it is the
highest-cost execution lane. Other run kinds can stay on the in-process bridge
until their payloads are proven self-contained.

Phase 3a implementation:

```text
RLM_WIKI_RUN_MODE=inline
  current production-safe behavior

RLM_WIKI_RUN_MODE=detached
  web process enqueues and immediately claims/executes through the bridge

RLM_WIKI_RUN_MODE=worker
  supported Code Anything jobs are enqueue-only from web
  wiki generation jobs are enqueue-only from web
  `rlm-wiki worker` claims and executes them
  unsupported jobs stay inline to preserve live SSE
```

This keeps activation reversible: unset `RLM_WIKI_RUN_MODE=worker` or stop the
worker service and the web service can return to inline/bridge execution.

## Phase 3.1 Rehearsal Switch

For the 10-user workshop, test the worker lane before relying on it:

```text
Browser
  |
  v
selfless-fulfillment web
  - RLM_WIKI_PROCESS=serve
  - RLM_WIKI_RUN_MODE=worker during rehearsal
  - enqueues supported Code Anything jobs
  |
  v
Postgres
  - product state
  - rlm_jobs
  - encrypted rlm_secret_grants
  ^
  |
selfless-worker
  - RLM_WIKI_PROCESS=worker
  - no public app traffic
  - claims run.code jobs
  - exposes /api/health only for Railway healthcheck
```

Activation should remain operationally boring:

```bash
bun run railway:worker-mode enable
bun run railway:worker-mode disable
```

If the rehearsal shows stuck jobs, streaming gaps, or noisy worker restarts,
switch back to `inline` for the workshop. If it drains cleanly and the web stays
responsive, keep one small worker on only for the demo window.

## Phase 3.2 Wiki Worker Lane

Wiki generation is the cleanest worker candidate:

```text
Browser
  |
  v
selfless-fulfillment web
  - validates BYOK/model access
  - creates wiki_generate run
  - enqueues run.wiki_generate
  - streams compact persisted progress from Postgres
  |
  v
Postgres
  - rlm_jobs
  - compact run events
  - final wiki artifact
  ^
  |
selfless-worker
  - claims run.wiki_generate
  - clones/indexes repo
  - plans structure
  - writes pages
  - persists compact progress
  - stores final wiki artifact
```

The browser does not need token-level wiki generation SSE. It needs clear
milestones: queued, structure planned, page N of M, finalized, ready. That keeps
Postgres write volume bounded and moves the expensive clone/page-writing work
off the web service.

## Phase 3.3 Background UX Contract

Once wiki generation runs in the worker lane, the browser is an observer, not the
executor. A dropped SSE connection should not cancel the job after it has been
accepted by the queue.

```text
Browser
  - starts wiki run
  - shows "running in background"
  - may keep watching compact milestones
  - may scroll away and check Library later

Worker + Postgres
  - continue the job
  - persist compact run events
  - save final wiki artifact
```

This keeps user trust without adding a paid realtime vendor. The next stronger
version is a small active-runs list backed by `ProductStore`, but the first move
is only a friendly background signal and compact worker progress.
