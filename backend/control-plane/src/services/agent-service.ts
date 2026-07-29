/**
 * Agent service.
 *
 * Two rules worth stating: agent versions are immutable, and publishing is the only
 * thing that increments a version. Every call records the exact version it ran, so
 * "which prompt produced this behaviour?" is always answerable (docs/03 6.7).
 */

import { newId } from '../domain/ids.js';
import { validateFlow } from '../domain/flow-schema.js';
import type { z } from 'zod';
import {
  agentSchema,
  pipelineConfigSchema,
  voiceConfigSchema,
  type updateAgentInput,
  type Agent,
  type CreateAgentInput,
} from '../domain/schemas.js';
import type { Call } from '../domain/call-schemas.js';
import type { CallRepository } from '../repositories/call-repository.js';

/** Nearest-rank percentile. Empty input is 0, not NaN — this renders in a table. */
function percentile(values: number[], p: number): number {
  const sorted = values.filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

type UpdateAgentInput = z.infer<typeof updateAgentInput>;
import { require_, type WorkspaceScope } from '../domain/tenant.js';
import {
  ConflictError,
  NotFoundError,
  type AgentRepository,
  type ListOptions,
  type WorkspaceRepository,
} from '../repositories/types.js';

/** Sensible starting pipeline. Speculative prefill and semantic endpointing ON by default —
 *  the whole latency thesis is worthless if the defaults are the slow path. */
const DEFAULT_PIPELINE = {
  // Real providers, not mocks. A new agent must be able to hold a real
  // conversation the moment credentials exist — wiring the sample agent to the
  // simulator meant "talk to your agent" could never work, which defeats the
  // 60-second activation path entirely (docs/11 §A).
  //
  // If no credentials are configured, the runtime endpoint reports exactly which
  // are missing and the worker refuses the call with an actionable message. That
  // is the honest failure; a silently-mocked call is not.
  sttProvider: 'deepgram-stt',
  llmProvider: 'anthropic-llm',
  llmModel: 'claude-haiku-4-5',
  ttsProvider: 'cartesia-tts',
  endpointingStrategy: 'semantic',
  bargeInStrategy: 'target-speaker',
  temperature: 0.3,
  maxTokens: 300,
  speculativePrefill: true,
  fillerEnabled: true,
};

const DEFAULT_VOICE = {
  providerKey: 'cartesia-tts',
  voiceId: 'a0e99841-438c-4a64-b679-ae501e7d6091',
  speed: 1,
  lexicon: [],
};

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  version: number;
  publishedAt: string;
  publishedBy: string;
  changeNote?: string;
  snapshot: Pick<Agent, 'prompt' | 'voice' | 'pipeline' | 'tools' | 'language'>;
}

export class AgentService {
  /** Version history. Postgres table in production; in-memory for Phase 1. */
  private readonly versions = new Map<string, AgentVersionRecord[]>();

  constructor(
    private readonly agents: AgentRepository,
    private readonly workspaces: WorkspaceRepository,
    /**
     * Calls, for per-agent statistics.
     *
     * Optional so existing constructions (tests, the simulator) keep working —
     * without it, stats stay at the stored zeros rather than throwing.
     */
    private readonly calls?: CallRepository,
  ) {}

  async list(scope: WorkspaceScope, opts?: ListOptions) {
    require_(scope, 'agent:read');
    const page = await this.agents.list(scope, opts);
    return { ...page, items: await this.withStats(scope, page.items) };
  }

  async get(scope: WorkspaceScope, agentId: string): Promise<Agent> {
    require_(scope, 'agent:read');
    const agent = await this.agents.get(scope, agentId);
    if (!agent) throw new NotFoundError('agent', agentId);
    return (await this.withStats(scope, [agent]))[0] ?? agent;
  }

  /**
   * Per-agent statistics, computed from the call log.
   *
   * `agent.stats` is written as zeros by `create` and nothing has ever updated
   * it — so "Calls today", "Success", "p50", "p95" and "Cost / call" were five
   * columns of `0` in the agent list and six zeroed cards on the agent page,
   * for every agent, forever. They looked like metrics and were a struct literal.
   *
   * They are derived here instead of denormalised onto the agent row: a counter
   * maintained on write has to be right on every path that touches a call
   * (ingest, retry, cancel, backfill) and is silently wrong the moment one
   * forgets. Reading the log cannot drift.
   *
   * Scoped to the caller's mode, so a browser rehearsal never inflates the
   * numbers next to calls that reached real customers — `CallService.list`
   * applies the same rule.
   */
  private async withStats(scope: WorkspaceScope, agents: Agent[]): Promise<Agent[]> {
    if (!this.calls || agents.length === 0) return agents;

    let calls: Call[];
    try {
      // One query for the workspace, then bucketed in memory: N agents would
      // otherwise mean N queries on a page that already renders a table.
      const page = await this.calls.list(scope, { page: 1, pageSize: 1000 });
      calls = page.items;
    } catch {
      // Statistics must never take down the agent list.
      return agents;
    }

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const startOfDay = midnight.getTime();

    const byAgent = new Map<string, Call[]>();
    for (const call of calls) {
      const bucket = byAgent.get(call.agentId);
      if (bucket) bucket.push(call);
      else byAgent.set(call.agentId, [call]);
    }

    return agents.map((agent) => {
      const mine = byAgent.get(agent.id) ?? [];
      if (mine.length === 0) return agent;

      const today = mine.filter((k) => new Date(k.startedAt).getTime() >= startOfDay);
      // "Did it work" is only answerable for calls that ended. Counting a call
      // still in progress as a failure makes the success rate dip whenever
      // someone is mid-conversation.
      const finished = mine.filter(
        (k) => k.status === 'completed' || k.status === 'failed' || k.status === 'no_answer',
      );
      const resolved = finished.filter(
        (k) => k.status === 'completed' && k.outcome === 'resolved',
      );

      return {
        ...agent,
        stats: {
          callsToday: today.length,
          successRate: finished.length ? resolved.length / finished.length : 0,
          avgLatencyMs: percentile(finished.map((k) => k.medianLatencyMs), 0.5),
          p95LatencyMs: percentile(finished.map((k) => k.p95LatencyMs), 0.95),
          avgDurationSec: finished.length
            ? Math.round(finished.reduce((s, k) => s + k.durationSec, 0) / finished.length)
            : 0,
          costPerCallUsd: finished.length
            ? finished.reduce((s, k) => s + k.costUsd, 0) / finished.length
            : 0,
        },
      };
    });
  }

  async create(scope: WorkspaceScope, input: CreateAgentInput): Promise<Agent> {
    require_(scope, 'agent:write');

    const workspace = await this.workspaces.get(scope, scope.workspaceId);
    if (!workspace) throw new NotFoundError('workspace', scope.workspaceId);

    const now = new Date().toISOString();
    const agent = agentSchema.parse({
      id: newId('agent'),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: input.name,
      status: 'draft',
      version: 1,
      description: input.description ?? '',
      language: input.language ?? 'en-US',
      prompt: input.prompt,
      modality: input.modality ?? 'voice',
      voice: voiceConfigSchema.parse({ ...DEFAULT_VOICE, ...(input.voice ?? {}) }),
      pipeline: pipelineConfigSchema.parse({ ...DEFAULT_PIPELINE, ...(input.pipeline ?? {}) }),
      tools: [],
      flow: input.flow,
      createdAt: now,
      updatedAt: now,
      stats: {
        callsToday: 0,
        successRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        avgDurationSec: 0,
        costPerCallUsd: 0,
      },
    } satisfies Agent);

    return this.agents.create(scope, agent);
  }

  /**
   * Edits apply to the DRAFT. A live agent keeps serving its published version
   * until someone publishes again — editing a prompt must never change behaviour
   * on calls already in flight.
   */
  async update(
    scope: WorkspaceScope,
    agentId: string,
    patch: UpdateAgentInput,
  ): Promise<Agent> {
    require_(scope, 'agent:write');
    const existing = await this.get(scope, agentId);

    // Only these fields are client-writable. Version, status, stats and tenancy
    // are system-owned and are simply not part of the input type.
    const merged: Partial<Agent> = {};
    if (patch.name !== undefined) merged.name = patch.name;
    if (patch.description !== undefined) merged.description = patch.description;
    if (patch.language !== undefined) merged.language = patch.language;
    if (patch.prompt !== undefined) merged.prompt = patch.prompt;
    if (patch.modality !== undefined) merged.modality = patch.modality;
    // The flow is a full replacement — the builder sends the whole compiled graph.
    if (patch.flow !== undefined) merged.flow = patch.flow;

    // Nested config merges rather than replaces.
    if (patch.voice) merged.voice = voiceConfigSchema.parse({ ...existing.voice, ...patch.voice });
    if (patch.pipeline) {
      merged.pipeline = pipelineConfigSchema.parse({ ...existing.pipeline, ...patch.pipeline });
    }

    return this.agents.update(scope, agentId, merged);
  }

  /**
   * Publish: snapshot the current config as an immutable version, bump the counter,
   * and mark the agent live.
   */
  async publish(
    scope: WorkspaceScope,
    agentId: string,
    changeNote?: string,
  ): Promise<{ agent: Agent; version: AgentVersionRecord }> {
    require_(scope, 'agent:publish');
    const agent = await this.get(scope, agentId);

    if (agent.status === 'archived') {
      throw new ConflictError('cannot publish an archived agent');
    }

    // A flow that can't run must not go live. The builder shows these as node badges;
    // this is the server-side backstop so a bad graph can't be published past the UI.
    if (agent.flow) {
      const errors = validateFlow(agent.flow, {
        modality: agent.modality,
        toolIds: agent.tools.map((t) => t.id),
      }).filter((i) => i.level === 'error');
      if (errors.length > 0) {
        throw new ConflictError(
          `cannot publish: the flow has ${errors.length} error(s) — first: ${errors[0]!.message}`,
        );
      }
    }

    const nextVersion = agent.version + 1;
    const record: AgentVersionRecord = {
      id: newId('agentVersion'),
      agentId,
      version: nextVersion,
      publishedAt: new Date().toISOString(),
      publishedBy: scope.userId,
      changeNote,
      snapshot: {
        prompt: agent.prompt,
        voice: agent.voice,
        pipeline: agent.pipeline,
        tools: agent.tools,
        language: agent.language,
      },
    };

    const history = this.versions.get(agentId) ?? [];
    history.push(record);
    this.versions.set(agentId, history);

    const updated = await this.agents.update(scope, agentId, {
      version: nextVersion,
      status: 'live',
    });
    return { agent: updated, version: record };
  }

  async listVersions(scope: WorkspaceScope, agentId: string): Promise<AgentVersionRecord[]> {
    require_(scope, 'agent:read');
    await this.get(scope, agentId); // scope check
    return [...(this.versions.get(agentId) ?? [])].sort((a, b) => b.version - a.version);
  }

  /** Restore a previous version's config into the draft. Never rewrites history. */
  async rollback(scope: WorkspaceScope, agentId: string, toVersion: number): Promise<Agent> {
    require_(scope, 'agent:publish');
    await this.get(scope, agentId);
    const record = (this.versions.get(agentId) ?? []).find((v) => v.version === toVersion);
    if (!record) throw new NotFoundError('agent version', `${agentId}@${toVersion}`);

    return this.agents.update(scope, agentId, { ...record.snapshot });
  }

  async delete(scope: WorkspaceScope, agentId: string): Promise<void> {
    require_(scope, 'agent:write');
    await this.get(scope, agentId);
    // Soft delete: call records reference this agent and must stay resolvable.
    await this.agents.update(scope, agentId, { status: 'archived' });
  }
}
