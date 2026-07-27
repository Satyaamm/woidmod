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

Voice agents mostly fail on the small things. They talk over you. They stop
mid-sentence because a dog barked. They mishear the order number you just read out
twice. They confidently invent a refund policy. Latency gets all the attention, but
what actually loses a customer is an agent that isn't *reliable* in conversation.

This platform is built around those failures.

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

### Build — form *or* flow
- **Visual flow builder** (drag-and-drop, `@xyflow/react`) *and* a form view over the
  same agent — one canvas for **voice and video** agents. Nodes for say, collect,
  tool-call, condition, human-handoff, plus deterministic guards (payment, verify,
  booking) and video nodes (escalate-to-video, vision, avatar, screen-share).
- The graph compiles to a spec the **orchestrator actually runs** — validated on
  publish (a flow that can't run can't go live), not just drawn.
- **Versioned agents** — publish, diff, roll back.

### Bring your own keys (BYOK)
- Connect **your own** LLM, speech-to-text and text-to-speech accounts — **20+
  providers** including Anthropic, OpenAI, Google Gemini/Vertex, **Azure OpenAI**,
  **AWS Bedrock**, Groq; Deepgram, AssemblyAI, Azure/Google Speech, Speechmatics,
  Soniox; Cartesia, ElevenLabs, PlayHT, Rime, OpenAI/Azure/Google TTS.
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

### Video — the AI joins the call, like a real person
- **Escalate a phone or web chat to a live video meeting** and the agent joins as a
  participant — it sees, speaks, and appears on screen.
- **Sees the caller** — a vision model (your BYOK key) reads what the camera or a
  shared screen shows and reasons about it, *asynchronously* so it never adds turn
  latency.
- **Shows a face** — a talking-head avatar that stops the instant you interrupt, in
  lockstep with the audio.
- **Multi-party aware** — in a room with real people, it speaks only when addressed.

### Telephony
- Inbound and outbound numbers, campaigns, reputation/attestation, warm transfer.
- **Compliance built in** — calling windows in the callee's local time, do-not-call
  screening, consent tracking, per-jurisdiction disclosure, and an append-only
  dispatch audit trail.

### For the team running it
- **Per-call trace** — every stage of every turn, time-aligned with the audio.
- **Workspaces** — separate brands, business units or clients, each with their own
  numbers, data region, spend caps and compliance posture.
- **RBAC** — built-in roles plus custom roles over a 38-permission catalog.
- **Test mode** — talk to your agent in the browser (voice *or* video) without a phone
  line or a cent of spend.

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

```bash
# 1. Infrastructure (Postgres, Redis, MinIO) — one file, one command
docker compose up -d
#    LiveKit: `livekit-server --dev` (brew) or add it to docker compose

# 2. Control-plane API  (:3101)
cd backend/control-plane && npm install && npm run dev

# 3. Dashboard  (:3100)
cd frontend && npm install && npm run dev

# 4. Orchestrator (only needed to place a real call)
cd backend/orchestrator && pip install -r requirements.txt && python -m src.main dev
```

Configuration is a **single root `.env`** read by all three services. Create an
account and you get a working agent immediately — no setup forms:

```bash
curl -X POST localhost:3101/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@acme.de","password":"a-good-passphrase","country":"DE"}'
```

That single call provisions your organization, a workspace, and a sample agent —
with the right language, data region and recording-consent rules **derived from your
country**. Add your provider keys under **Settings → Providers**, then talk to the
agent in the browser.

## Project layout

```
backend/
  control-plane/   TypeScript API — tenancy, RBAC, BYOK, compliance, agents, flows,
                   knowledge, tools, integrations, evals, telephony  (Postgres)
  orchestrator/    Python — the live conversation loop on LiveKit (voice + video)
frontend/          Next.js + Ant Design dashboard
docker-compose.yml Postgres · Redis · MinIO
.env               single config file for all three services
```

## Status

The control-plane, dashboard, and orchestrator run end-to-end. Built and verified:
tenancy + RBAC, BYOK credentials (20+ providers, encrypted), account/config +
telephony persistence to Postgres (survives restart), the visual flow builder and its
runtime execution, knowledge/tools/integrations/evals, compliance controls, and the
voice + video pipelines (vision, avatar, escalate, multi-party addressing).

To place a real **audible** call you supply your own STT/LLM/TTS keys (BYOK). A live
**video** call additionally needs a vision-capable model key; the avatar's photoreal
tier plugs a vendor in behind a built interface. Expect things to move.

## Contributing

`main` is protected — changes land through a reviewed pull request with CI passing.
See [CONTRIBUTING.md](CONTRIBUTING.md). Start from `develop`.

## Disclaimer

Documentation here is written for engineering purposes and is **not legal advice**.
Compliance features are tools to help you meet your obligations, not a guarantee that
you do.
