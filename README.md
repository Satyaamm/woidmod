<div align="center">

# woidmod

**An AI voice & video agent platform that sounds — and shows up — like a real person, not software.**

Build phone, web and video agents that answer, understand, act on your systems, join
a meeting when a caller asks to "hop on a quick call," and hand off to a human when
they should.

[Contributing](CONTRIBUTING.md)

</div>

---

## Why

Conversational agents mostly fail on the small things. They talk over you. They stop
mid-sentence because a dog barked. They mishear the order number you just read out
twice. They confidently invent a refund policy. And when the conversation stops being
something you can have with your ears — "can you see what my screen is doing?" — they
have nowhere to go. Latency gets all the attention, but what actually loses a customer
is an agent that isn't *reliable* in conversation, and can't change modality when the
problem does.

This platform is built around those failures.

**It is not a voice product with video bolted on.** One agent, one flow graph, one
trace: it can answer a phone call, escalate into a video meeting it joins as a
participant, read a shared screen, and hand off to a human — without changing agent,
losing context, or starting a new session.

---

## What's in here

| | |
|---|---|
| **Build** | Visual flow builder and a form view over the same agent · versioned drafts with publish, diff and rollback · prompt hygiene checks |
| **Converse** | Semantic turn-taking · playout-accurate barge-in · speculative prefill · backchannel awareness · filler on slow lookups |
| **Understand** | Slot-aware capture of IDs, emails and postcodes · vocabulary biasing · per-workspace pronunciation lexicon |
| **See & appear** | Escalate to video · vision over camera and screen share · talking-head avatar · multi-party addressing |
| **Act** | Knowledge/RAG with retrieval preview · HTTP tools executed server-side · HMAC-signed webhooks with replay · human handoff |
| **Reach** | Inbound and outbound numbers · SIP trunking · outbound campaigns and dialer · reputation/attestation · warm transfer |
| **Prove** | Per-call trace time-aligned to audio · eval suites and scored runs · analytics · cost per call |
| **Run** | Orgs → workspaces → agents · RBAC over a 38-permission catalog · custom roles · API keys · MFA and SSO · spend caps |
| **Comply** | Hash-chained audit log · per-tenant envelope encryption · PII redaction · data-subject rights · provider-eligibility gate · data residency |

## Features

### Natural conversation
- **Semantic turn-taking** — decides you've finished from your words *and* your
  intonation, not a silence stopwatch. It replies fast when you're clearly done and
  waits when you're mid-thought.
- **Interruption handling** — talk over the agent and it stops immediately, then
  remembers exactly how much you actually heard (playout-accurate barge-in).
- **Speculative prefill** — the reply starts forming before you've quite finished, and
  is discarded if you resume. Faster without guessing.
- **Backchannel awareness** — an "mhm" doesn't derail it.
- **No dead air** — a natural "let me check that" covers slow lookups.

### Understanding what people actually say
- **Reliable capture of order IDs, emails, postcodes and reference numbers** —
  slot-aware recognition with confidence-targeted confirm-back, so the agent asks
  about the one character it's unsure of instead of reading the whole thing back.
- **Accent and telephony robustness** on narrowband audio.
- **Your vocabulary** — product names, SKUs and place names biased into recognition,
  plus a per-workspace pronunciation lexicon.

### Speaking properly
- **Many locales** with honest quality tiers — English, German, French, Spanish,
  Italian, Dutch, Portuguese, Polish and more.
- **Formal / informal register** — du vs Sie, tu vs vous. Getting this wrong is rude
  in a way English has no equivalent for, and no TTS vendor handles it.
- **Correct pronunciation of numbers, money, dates, URLs and emails** per language.
  `10/03` is October 3rd in the US and 10 March in Europe; getting that wrong books
  the wrong appointment.

### Video — the AI joins the call, like a real person
- **Escalate a phone or web chat to a live video meeting** and the agent joins as a
  participant — it sees, speaks, and appears on screen.
- **Sees the caller** — a vision model (your BYOK key) reads what the camera or a
  shared screen shows and reasons about it, *asynchronously* so it never adds turn
  latency.
- **Shows a face** — a talking-head avatar that stops the instant you interrupt, in
  lockstep with the audio.
- **Multi-party aware** — in a room with real people, it speaks only when addressed.

### Build — form *or* flow
- **Visual flow builder** (drag-and-drop, `@xyflow/react`) *and* a form view over the
  same agent — one canvas for **voice and video** agents. Nodes for say, collect,
  tool-call, condition, human-handoff, plus deterministic guards (payment, verify,
  booking) and video nodes (escalate-to-video, vision, avatar, screen-share).
- The graph compiles to a spec the **orchestrator actually runs** — validated on
  publish (a flow that can't run can't go live), not just drawn.
- **Versioned agents** — publish, diff, roll back.

### Bring your own keys (BYOK)
- Connect **your own** LLM, speech-to-text and text-to-speech accounts — **21
  providers**, every one of which the call worker can actually run: Anthropic,
  OpenAI, Google Gemini/Vertex, **Azure OpenAI**, **AWS Bedrock**, Groq; Deepgram,
  AssemblyAI, Cartesia Ink, Azure/Google Speech, Speechmatics, Soniox; Cartesia,
  ElevenLabs, Rime, OpenAI/Azure/Google TTS.
- **Any OpenAI-compatible gateway** counts as one more: point the OpenAI provider's
  base URL at LiteLLM, OpenRouter, Together, Fireworks, vLLM or Ollama and run a
  model this list has never heard of.
- **Test connection** before you save. The button in the credential form makes a
  real authenticated call to the vendor and tells you which field is wrong — a
  typo'd Azure deployment name, a PlayHT key paired with the wrong user id, a
  Speechmatics key issued for the other data centre. Nothing is stored until it
  passes, and the same check re-runs on demand for keys already saved.
- Each vendor's **real** auth is collected (Bedrock IAM keys, Vertex service-account
  JSON, Azure resource + deployment, PlayHT key + user id). Secrets are **encrypted
  per tenant** (envelope encryption); crypto-shredding a tenant's key erases them.
- Your keys mean your commercial terms, your DPA/BAA, and your region — the platform
  is not a sub-processor for that leg.

### Doing real work
- **Knowledge (RAG)** — attach sources, chunked and retrievable, with a preview that
  shows *why* each chunk was or wasn't retrieved.
- **Tools** — HTTP functions the agent calls, executed server-side so your secrets
  never reach the browser; test them from the dashboard.
- **Integrations** — outbound webhooks, **HMAC-signed** (`X-Woidmod-Signature`),
  with a delivery log and one-click replay.
- **Evals** — test suites and scored runs against an agent version.
- **Guardrails & human handoff** — grounded answers, AI-disclosure on request, and a
  clean handoff carrying the full conversation summary.

### Telephony & outbound
- Inbound and outbound numbers, SIP trunking, warm transfer, reputation/attestation.
- **Campaigns** — lead lists, a pacing dialer, live progress, pause/stop.
- **Compliance built in** — calling windows in the callee's local time, do-not-call
  screening, consent tracking, per-jurisdiction disclosure, and an append-only
  dispatch audit trail.

### For the team running it
- **Per-call trace** — every stage of every turn, time-aligned with the audio.
- **Analytics and cost** — volume, latency percentiles, outcomes, and cost per call
  attributed per agent.
- **Workspaces** — separate brands, business units or clients, each with their own
  numbers, data region, spend caps and compliance posture.
- **RBAC** — built-in roles plus custom roles over a 38-permission catalog.
- **Accounts** — email/password with verification, TOTP MFA, SSO, invitations, and
  workspace-scoped API keys shown exactly once.
- **Test mode** — talk to your agent in the browser (voice *or* video) without a phone
  line or a cent of spend.

### Compliance, in the product rather than a PDF
- **Hash-chained audit log** with an integrity check an auditor can run.
- **Envelope encryption per tenant** — crypto-shredding a tenant's key renders their
  stored secrets unreadable, which is what makes erasure real.
- **Data-subject rights** — export and erasure scoped to one person, not one workspace.
- **Provider-eligibility gate** — an EU-pinned or HIPAA workspace cannot select a
  vendor that doesn't satisfy it, re-checked at dispatch and not just at save.
- **PII redaction** in logs and traces.

---

## Architecture

Three services, plus managed infrastructure. **Own the conversation logic; rent the
commodity layers.**

```
┌──────────────┐    HTTPS    ┌────────────────────┐   fetch config + BYOK keys
│  Dashboard    │ ─────────▶ │   control-plane     │ ◀───────────────┐
│ Next.js + AntD│            │ TypeScript · Hono   │                 │
│ Zustand·xyflow│            │ Zod · Drizzle       │                 │
└──────────────┘            │ Postgres (RLS)      │                 │
                            │ tenancy, RBAC, BYOK, │                 │
                            │ compliance, agents,  │          ┌──────┴───────┐
                            │ flows, knowledge…    │          │ orchestrator  │
                            └─────────┬───────────┘          │ Python·LiveKit│
                                      │                       │ the live loop:│
   browser / phone  ── WebRTC/SIP ──▶ │  LiveKit (media)  ◀──▶│ endpointing,  │
                                      │                       │ barge-in,     │
                                      │                       │ flow engine,  │
                                      │                       │ vision/avatar │
                                      │                       └──────┬───────┘
                                      │                              │ BYOK
                              Postgres · Redis · S3/MinIO      cloud STT/LLM/TTS
```

- **`backend/control-plane`** (TypeScript, Hono, Zod, Drizzle/Postgres) — the API and
  system of record: org → workspace → agent tenancy, auth, RBAC, BYOK provider
  credentials (encrypted per tenant), compliance (hash-chained audit log, PII
  redaction, provider-eligibility gate, envelope encryption), agents + flow specs,
  knowledge, tools, integrations, evals, telephony. Row-level security on every
  tenant table.
- **`backend/orchestrator`** (Python, LiveKit Agents) — the real-time conversation
  loop: semantic endpointing, speculative prefill, clause-boundary TTS, playout-
  accurate barge-in, flow-graph execution, and the video pipeline (vision + avatar).
- **`frontend`** (Next.js App Router, Ant Design, Zustand, `@xyflow/react`) — the
  dashboard.

**Media** is handled by **LiveKit** (WebRTC + SIP). **Models** are served by the
customer's **own cloud provider accounts (BYOK)**. Owning either of those layers is a
scale-phase choice, not a requirement — so there is deliberately no media/inference
service here.

## Getting started

Requires Docker, Node 20+ and Python 3.11+.

```bash
cp .env.example .env     # dev defaults match docker compose; nothing to edit
./start.sh               # infra + API + dashboard + worker, logs streamed and tagged
```

- Dashboard → <http://localhost:3100>
- API → <http://localhost:3101>

`./start.sh --no-orchestrator` skips the Python worker (dashboard only, no real
calls). `Ctrl+C` stops the app; `./start.sh --down` also stops the containers.

<details>
<summary>Running the four pieces by hand</summary>

```bash
docker compose up -d                                   # Postgres · Redis · MinIO · LiveKit
cd backend/control-plane && npm install && npm run dev  # API        :3101
cd frontend              && npm install && npm run dev  # dashboard  :3100
cd backend/orchestrator  && pip install -r requirements.txt && python -m src.main dev
```
</details>

Configuration is a **single root `.env`** read by all three services. Sign up in the
dashboard, or from the command line:

```bash
curl -X POST localhost:3101/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-good-passphrase","country":"DE"}'
```

That single call provisions your organization, a workspace, and a working agent —
with the right language, data region and recording-consent rules **derived from your
country**.

### Then: connect your keys

`.env` holds **infrastructure** secrets only. Provider keys are BYOK, stored
encrypted per tenant, and added in the dashboard under **Providers** — there is no
platform key pool. A call needs one of each:

| Stage | Cheapest way to get going |
|---|---|
| Speech-to-text | Deepgram or AssemblyAI (both give free credit) |
| Language model | Groq or Google AI Studio (both have a free tier) |
| Text-to-speech | Cartesia, or OpenAI if you already have a key |

Hit **Test connection** in the credential form — it calls the vendor and names the
field that's wrong before anything is saved. Then pick the providers on your agent's
**Pipeline** tab and use **Test call** to talk to it in the browser.

**LiveKit needs no account**: `docker compose` runs `livekit-server --dev` locally
with the well-known dev key pair already in `.env.example`. A LiveKit Cloud project is
only needed for real phone numbers (SIP).

## Project layout

```
backend/
  control-plane/   TypeScript API — tenancy, RBAC, BYOK, compliance, agents, flows,
    src/api/       HTTP surface (auth at the root, everything else under /v1)
    src/services/  agents, calls, campaigns, knowledge, tools, evals, telephony, billing
    src/providers/ 21 vendor adapters, the BYOK catalog, and live credential probes
    src/compliance/ audit log, encryption, PII, eligibility, data-subject rights
    src/i18n/      locales + per-language verbalization (numbers, money, dates)
    src/db/        migrations and row-level-security policies
  orchestrator/    Python — the live conversation loop on LiveKit (voice + video)
    src/           endpointer, turn detector, playout, flow engine, vision, avatar
frontend/          Next.js App Router + Ant Design dashboard (38 pages)
    src/features/  one folder per product area; src/app mirrors the routes
docker-compose.yml Postgres · Redis · MinIO · LiveKit
.env               single config file for all three services
```

## Status

Honest version, because a README that overstates is the most expensive kind.

**Works end to end.** Tenancy, auth (verification, MFA, SSO, invitations), RBAC and
custom roles, BYOK credentials for 21 providers — every one runnable by the worker and
verifiable against the vendor from the dashboard — agents with versioning/publish/
rollback, the visual flow builder compiling to a spec the worker actually executes,
knowledge, tools, webhooks, evals, telephony and campaigns, the compliance controls
above, and the voice + video pipelines (vision, avatar, escalate, multi-party
addressing). Config and telephony persist to Postgres and survive a restart.

**Needs your keys.** A real **audible** call needs your own STT + LLM + TTS keys. A
live **video** call additionally needs a vision-capable model key.

**Known gaps, surfaced in the UI rather than hidden:**

| Gap | What the product does about it |
|---|---|
| **PlayHT** can't run calls — LiveKit stopped publishing `livekit-plugins-playai` at 1.2.x, the worker runs 1.6.6 | Catalog marks it not-runnable, the pipeline dropdown disables it, readiness refuses to call the agent ready |
| **Voice preview** — synthesis needs somewhere to host the clip | Button disabled with the reason; use Test call to hear a voice |
| **Billing** — no payment provider connected | Plan switching, cards and invoice PDFs are disabled with the reason; usage and cost are real |
| **Integration connectors** (CRM/helpdesk) not built | Cards disabled; webhooks and HTTP tools cover the same ground |
| **Avatar photoreal tier** — vendor plugs in behind a built interface | The interface exists; no vendor wired |
| **Notifications** — no store or endpoint | Bell disabled rather than showing a fake unread badge |

Expect things to move.

## Contributing

`main` is protected — changes land through a reviewed pull request with CI passing.
See [CONTRIBUTING.md](CONTRIBUTING.md). Start from `develop`.

## Disclaimer

Documentation here is written for engineering purposes and is **not legal advice**.
Compliance features are tools to help you meet your obligations, not a guarantee that
you do.
