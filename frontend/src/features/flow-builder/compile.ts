import type { Edge, Node } from '@xyflow/react';
import type { FlowEdge, FlowNode, FlowNodeType, FlowSpec } from '@/lib/contract';

/** Data carried on every xyflow node in the builder. */
export interface FlowNodeData extends Record<string, unknown> {
  /** Node type — duplicated onto data so the shared card can read it. */
  nodeType: FlowNodeType;
  /** Type-specific config; this is exactly what round-trips to `FlowNode.data`. */
  config: Record<string, unknown>;
}

export type BuilderNode = Node<FlowNodeData>;
export type BuilderEdge = Edge;

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function newNodeId(): string {
  return `n_${shortId()}`;
}

export function newEdgeId(): string {
  return `e_${shortId()}`;
}

/** Compile the canvas graph into the wire `FlowSpec`. */
export function toFlowSpec(
  nodes: BuilderNode[],
  edges: BuilderEdge[],
  entryNodeId: string,
): FlowSpec {
  const flowNodes: FlowNode[] = nodes.map((n) => ({
    id: n.id,
    type: (n.data.nodeType ?? (n.type as FlowNodeType)) as FlowNodeType,
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    data: (n.data.config ?? {}) as Record<string, unknown>,
  }));

  const flowEdges: FlowEdge[] = edges.map((e) => {
    const handle = e.sourceHandle ?? undefined;
    const out: FlowEdge = { id: e.id, source: e.source, target: e.target };
    // 'out' is the synthetic single-exit handle — it maps to "no sourceHandle".
    if (handle && handle !== 'out') out.sourceHandle = handle;
    if (typeof e.label === 'string' && e.label) out.label = e.label;
    return out;
  });

  return { version: 1, entryNodeId, nodes: flowNodes, edges: flowEdges };
}

/** Expand a stored `FlowSpec` back into canvas nodes + edges. */
export function fromFlowSpec(spec: FlowSpec): { nodes: BuilderNode[]; edges: BuilderEdge[] } {
  const nodes: BuilderNode[] = spec.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: { nodeType: n.type, config: n.data ?? {} },
  }));

  const edges: BuilderEdge[] = spec.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? 'out',
    label: e.label,
  }));

  return { nodes, edges };
}
