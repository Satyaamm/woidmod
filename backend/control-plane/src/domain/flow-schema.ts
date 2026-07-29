/**
 * Agent flow specification — the graph the visual (xyflow) builder compiles to and
 * the orchestrator executes.
 *
 * The design goal (docs: PLATFORM-ROADMAP §3): the flow is NOT a second, competing
 * source of truth against the prompt. It is the DETERMINISTIC skeleton — the steps
 * that must not improvise (collect this field, call this tool, take payment, escalate
 * to video, hand off) — while prompt-driven conversation happens *inside* a node. A
 * `say` node with a `prompt` runs a normal LLM turn; a `collect` node runs turns until
 * the slot is filled; a `condition` node routes on a computed expression.
 *
 * One catalog serves BOTH voice and video agents. Video nodes (escalate_video, vision,
 * avatar, screen_share) are only valid when the agent's `modality` includes video —
 * `validateFlow` enforces that, so a voice agent can't ship a graph it can't run.
 *
 * The spec is versioned and self-contained: an agent version snapshots its flow, so
 * "what exactly did this agent do on the 3rd" stays answerable forever.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const nodeIdSchema = z.string().min(1).max(64);

/** Canvas coordinates. The builder needs them; the runtime ignores them. */
const positionSchema = z.object({ x: z.number(), y: z.number() });

/** A stored variable name a node writes to / reads from (slots, tool results). */
const varNameSchema = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'variable names are identifiers: letters, digits, underscore');

export const flowNodeTypeSchema = z.enum([
  // Core — both modalities
  'start',
  'say',
  'collect',
  'tool',
  'condition',
  'handoff',
  'end',
  // Deterministic guarded steps — must not improvise (payment, KYC, booking)
  'payment',
  'verify',
  'booking',
  // Video — valid only when modality includes video
  'escalate_video',
  'vision',
  'avatar',
  'screen_share',
]);
export type FlowNodeType = z.infer<typeof flowNodeTypeSchema>;

/** Node types that require a video-capable agent. */
export const VIDEO_NODE_TYPES: readonly FlowNodeType[] = [
  'escalate_video',
  'vision',
  'avatar',
  'screen_share',
];

/** Node types that legitimately have no outgoing edge (conversation ends there). */
export const TERMINAL_NODE_TYPES: readonly FlowNodeType[] = ['end', 'handoff'];

// ---------------------------------------------------------------------------
// Per-node data
// ---------------------------------------------------------------------------

const startData = z.object({}).strict();

const sayData = z
  .object({
    /** A fixed line, read verbatim. Mutually exclusive with `prompt` in practice. */
    text: z.string().max(4000).optional(),
    /** An instruction for a prompt-driven LLM turn. */
    prompt: z.string().max(8000).optional(),
    /** Wait for the caller to respond before advancing (vs. a one-way announcement). */
    expectReply: z.boolean().default(true),
  })
  .strict()
  .refine((d) => d.text || d.prompt, { message: 'a say node needs `text` or `prompt`' });

const collectData = z
  .object({
    /** The slot this fills, e.g. `orderId`, `email`. */
    slot: varNameSchema,
    /** How to ask. Prompt-driven so it adapts to what the caller already said. */
    prompt: z.string().min(1).max(8000),
    /** Read the value back for confirmation before advancing (confidence-gated at runtime). */
    confirm: z.boolean().default(false),
    /** A named validator (email, e164, postcode, regex:…) applied before the slot is accepted. */
    validation: z.string().max(200).optional(),
    maxRetries: z.number().int().min(1).max(10).default(3),
  })
  .strict();

const toolData = z
  .object({
    /** References a tool in the agent's `tools[]`. */
    toolId: z.string().min(1),
    /** Variable the tool result is stored in, for later nodes/conditions. */
    resultVar: varNameSchema.optional(),
  })
  .strict();

/**
 * A branch is a named exit. An edge whose `sourceHandle` equals the branch `id` is the
 * route taken when `when` evaluates true; the first matching branch wins, else the
 * `default` handle. Keeping branches on the node (not only on edges) lets the builder
 * render labelled ports and lets `validateFlow` check every branch has an edge.
 */
const conditionBranch = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(120),
  /** A boolean expression over collected vars, e.g. `amount > 100 && country == "US"`. */
  when: z.string().min(1).max(500),
});

const conditionData = z
  .object({
    branches: z.array(conditionBranch).min(1).max(20),
    /** Always present: the fall-through when no branch matches. */
    hasDefault: z.literal(true).default(true),
  })
  .strict();

const handoffData = z
  .object({
    /** Queue / team to route to. */
    queue: z.string().max(120).optional(),
    reason: z.string().max(500).optional(),
    /** Carry a generated conversation summary across to the human. */
    summary: z.boolean().default(true),
  })
  .strict();

const endData = z
  .object({
    reason: z.string().max(200).optional(),
    /** Disposition written to the call record. */
    disposition: z.string().max(80).optional(),
  })
  .strict();

// -- Deterministic guarded steps -------------------------------------------

const paymentData = z
  .object({
    /** Amount source: a var name or a fixed minor-unit integer. */
    amountVar: varNameSchema.optional(),
    amountFixedMinor: z.number().int().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    description: z.string().max(200).optional(),
    /** PSP tool this drives (Stripe, Adyen…) — references agent tools. */
    providerToolId: z.string().optional(),
  })
  .strict();

const verifyData = z
  .object({
    method: z.enum(['otp', 'kba', 'dob', 'postcode']),
    /** What is being verified against, e.g. `phone`, `email`. */
    against: varNameSchema.optional(),
    maxAttempts: z.number().int().min(1).max(6).default(3),
  })
  .strict();

const bookingData = z
  .object({
    /** Calendar/scheduling tool this drives. */
    calendarToolId: z.string().optional(),
    durationMin: z.number().int().min(5).max(480).default(30),
    /** Var holding the chosen slot / that the booking id is written to. */
    slotVar: varNameSchema.optional(),
  })
  .strict();

// -- Video nodes ------------------------------------------------------------

const escalateVideoData = z
  .object({
    /** How the agent proposes moving to video. */
    prompt: z.string().max(4000).optional(),
    /** Require the caller to accept before switching tracks. */
    requireConsent: z.boolean().default(true),
  })
  .strict();

const visionData = z
  .object({
    /** What the agent looks at. */
    target: z.enum(['camera', 'screen']),
    /** What to look for, fed to the vision-language model. */
    instruction: z.string().min(1).max(2000),
    /** Var the scene description is written to. */
    resultVar: varNameSchema.optional(),
  })
  .strict();

const avatarData = z
  .object({
    /** Turn the talking-head avatar on/off from this point. */
    enabled: z.boolean().default(true),
    avatarId: z.string().max(120).optional(),
    style: z.string().max(80).optional(),
  })
  .strict();

const screenShareData = z
  .object({
    /** Who shares: the agent shows something, or reads the caller's screen. */
    direction: z.enum(['agent', 'caller']),
    /** For agent→caller: the URL/asset to present. */
    url: z.string().url().max(2048).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Node (discriminated union) + edge
// ---------------------------------------------------------------------------

const baseNode = { id: nodeIdSchema, position: positionSchema };

export const flowNodeSchema = z.discriminatedUnion('type', [
  z.object({ ...baseNode, type: z.literal('start'), data: startData.default({}) }),
  z.object({ ...baseNode, type: z.literal('say'), data: sayData }),
  z.object({ ...baseNode, type: z.literal('collect'), data: collectData }),
  z.object({ ...baseNode, type: z.literal('tool'), data: toolData }),
  z.object({ ...baseNode, type: z.literal('condition'), data: conditionData }),
  z.object({ ...baseNode, type: z.literal('handoff'), data: handoffData }),
  z.object({ ...baseNode, type: z.literal('end'), data: endData.default({}) }),
  z.object({ ...baseNode, type: z.literal('payment'), data: paymentData }),
  z.object({ ...baseNode, type: z.literal('verify'), data: verifyData }),
  z.object({ ...baseNode, type: z.literal('booking'), data: bookingData }),
  z.object({ ...baseNode, type: z.literal('escalate_video'), data: escalateVideoData }),
  z.object({ ...baseNode, type: z.literal('vision'), data: visionData }),
  z.object({ ...baseNode, type: z.literal('avatar'), data: avatarData }),
  z.object({ ...baseNode, type: z.literal('screen_share'), data: screenShareData }),
]);
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: nodeIdSchema,
  target: nodeIdSchema,
  /**
   * For nodes with multiple exits, which port this leaves from:
   *   condition → a branch id, or 'default'
   *   collect   → 'filled' | 'failed'
   *   verify    → 'passed' | 'failed'
   *   escalate_video → 'accepted' | 'declined'
   * Omitted for single-exit nodes.
   */
  sourceHandle: z.string().max(64).optional(),
  label: z.string().max(120).optional(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowSpecSchema = z.object({
  version: z.literal(1).default(1),
  /** The Start node. Every run begins here. */
  entryNodeId: nodeIdSchema,
  nodes: z.array(flowNodeSchema).max(500),
  edges: z.array(flowEdgeSchema).max(2000),
});
export type FlowSpec = z.infer<typeof flowSpecSchema>;

export const agentModalitySchema = z.enum(['voice', 'video', 'both']);
export type AgentModality = z.infer<typeof agentModalitySchema>;

// ---------------------------------------------------------------------------
// Semantic validation
//
// The Zod schemas above prove a flow is well-FORMED. `validateFlow` proves it is
// RUNNABLE: reachable, wired to a real tool set, terminating, and legal for the
// agent's modality. The builder renders these as per-node badges; the publish
// endpoint refuses to make a flow live while any `error` remains. Warnings inform
// but don't block.
// ---------------------------------------------------------------------------

export interface FlowIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface FlowValidationContext {
  modality: AgentModality;
  /** Ids of tools defined on the agent — tool/payment/booking nodes must reference one. */
  toolIds: string[];
}

/** Required exit handles per multi-exit node type; single-exit types map to []. */
function requiredHandles(node: FlowNode): string[] {
  switch (node.type) {
    case 'condition':
      return [...node.data.branches.map((b) => b.id), 'default'];
    case 'collect':
      return ['filled'];
    case 'verify':
      return ['passed'];
    case 'escalate_video':
      return ['accepted'];
    default:
      return [];
  }
}

export function validateFlow(spec: FlowSpec, ctx: FlowValidationContext): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const err = (code: string, message: string, extra?: Partial<FlowIssue>) =>
    issues.push({ level: 'error', code, message, ...extra });
  const warn = (code: string, message: string, extra?: Partial<FlowIssue>) =>
    issues.push({ level: 'warning', code, message, ...extra });

  // -- Node ids unique, entry present --------------------------------------
  const byId = new Map<string, FlowNode>();
  for (const node of spec.nodes) {
    if (byId.has(node.id)) err('duplicate_node', `Duplicate node id "${node.id}".`, { nodeId: node.id });
    byId.set(node.id, node);
  }

  const starts = spec.nodes.filter((n) => n.type === 'start');
  if (starts.length === 0) err('no_start', 'The flow has no Start node.');
  if (starts.length > 1)
    err('multiple_starts', 'The flow has more than one Start node.', { nodeId: starts[1]?.id });
  if (!byId.has(spec.entryNodeId))
    err('bad_entry', `entryNodeId "${spec.entryNodeId}" is not a node in the flow.`);
  else if (byId.get(spec.entryNodeId)!.type !== 'start')
    err('entry_not_start', 'entryNodeId must point at the Start node.', { nodeId: spec.entryNodeId });

  const toolIds = new Set(ctx.toolIds);
  const videoOk = ctx.modality === 'video' || ctx.modality === 'both';

  // -- Edges reference real nodes ------------------------------------------
  const outgoing = new Map<string, FlowEdge[]>();
  for (const edge of spec.edges) {
    if (!byId.has(edge.source))
      err('dangling_edge', `Edge "${edge.id}" leaves a node that doesn't exist.`, { edgeId: edge.id });
    if (!byId.has(edge.target))
      err('dangling_edge', `Edge "${edge.id}" targets a node that doesn't exist.`, { edgeId: edge.id });
    (outgoing.get(edge.source) ?? outgoing.set(edge.source, []).get(edge.source)!).push(edge);
  }

  // -- Per-node checks ------------------------------------------------------
  for (const node of spec.nodes) {
    const outs = outgoing.get(node.id) ?? [];

    // Modality
    if (VIDEO_NODE_TYPES.includes(node.type) && !videoOk)
      err('video_node_on_voice', `"${node.type}" needs a video-capable agent (set modality to video or both).`, { nodeId: node.id });

    // Tool references
    if (node.type === 'tool' && !toolIds.has(node.data.toolId))
      err('unknown_tool', `Tool node references unknown tool "${node.data.toolId}".`, { nodeId: node.id });
    if (node.type === 'payment' && node.data.providerToolId && !toolIds.has(node.data.providerToolId))
      err('unknown_tool', `Payment node references unknown PSP tool "${node.data.providerToolId}".`, { nodeId: node.id });
    if (node.type === 'booking' && node.data.calendarToolId && !toolIds.has(node.data.calendarToolId))
      err('unknown_tool', `Booking node references unknown calendar tool "${node.data.calendarToolId}".`, { nodeId: node.id });

    // Exits
    const isTerminal = TERMINAL_NODE_TYPES.includes(node.type);
    if (isTerminal) {
      if (outs.length > 0)
        warn('terminal_has_exit', `"${node.type}" is an end of the conversation; its outgoing edge is ignored.`, { nodeId: node.id });
      continue;
    }
    if (outs.length === 0) {
      err('dead_end', `Node "${node.id}" (${node.type}) has no outgoing path — the conversation would stall here.`, { nodeId: node.id });
      continue;
    }

    // Required handles present
    const handles = new Set(outs.map((e) => e.sourceHandle ?? ''));
    for (const required of requiredHandles(node)) {
      if (!handles.has(required))
        err('missing_branch', `Node "${node.id}" (${node.type}) is missing its "${required}" exit.`, { nodeId: node.id });
    }
  }

  // -- Reachability from entry ---------------------------------------------
  if (byId.has(spec.entryNodeId)) {
    const seen = new Set<string>([spec.entryNodeId]);
    const queue = [spec.entryNodeId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const edge of outgoing.get(id) ?? []) {
        if (byId.has(edge.target) && !seen.has(edge.target)) {
          seen.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of spec.nodes) {
      if (!seen.has(node.id))
        warn('unreachable', `Node "${node.id}" (${node.type}) can't be reached from Start.`, { nodeId: node.id });
    }
    const reachesEnd = [...seen].some((id) => byId.get(id)?.type === 'end');
    if (!reachesEnd)
      warn('no_end', 'No End node is reachable — the flow never formally completes.');
  }

  return issues;
}

/** A minimal valid flow: Start → End. The builder seeds a new agent with this. */
export function emptyFlow(): FlowSpec {
  return {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
      { id: 'end', type: 'end', position: { x: 0, y: 200 }, data: {} },
    ],
    edges: [{ id: 'start-end', source: 'start', target: 'end' }],
  };
}

