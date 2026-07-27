'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { FlowIssue, FlowNodeType } from '@/lib/contract';
import type { BuilderEdge, BuilderNode, FlowNodeData } from './compile';
import { NODE_CATALOG, resolveExits } from './nodeCatalog';
import { summarizeNode } from './nodeSummary';

export const DND_MIME = 'application/woidmod-flow-node';

// ---------------------------------------------------------------------------
// Issues context — lets each node read the validation issues that target it.
// ---------------------------------------------------------------------------

const IssuesContext = createContext<Record<string, FlowIssue[]>>({});

function useNodeIssues(nodeId: string): FlowIssue[] {
  return useContext(IssuesContext)[nodeId] ?? [];
}

const useStyles = createStyles(({ token, css }) => ({
  node: css`
    min-width: 168px;
    max-width: 240px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgElevated};
    box-shadow: ${token.boxShadowTertiary};
    font-size: 12px;
    transition: border-color 0.15s, box-shadow 0.15s;
  `,
  selected: css`
    border-color: ${token.colorPrimary};
    box-shadow: 0 0 0 2px ${token.colorPrimaryBorder};
  `,
  errored: css`
    border-color: ${token.colorError};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid ${token.colorFillQuaternary};
    font-weight: 600;
  `,
  body: css`
    padding: 7px 10px 10px;
    color: ${token.colorTextTertiary};
    font-size: 11.5px;
    line-height: 1.5;
    word-break: break-word;
  `,
  exitLabel: css`
    position: absolute;
    bottom: -6px;
    transform: translateX(-50%);
    font-size: 9px;
    line-height: 1;
    color: ${token.colorTextQuaternary};
    pointer-events: none;
    white-space: nowrap;
  `,
}));

// ---------------------------------------------------------------------------
// The shared node card — renders icon/label/summary + the right handles.
// ---------------------------------------------------------------------------

function FlowNodeCard({ id, data, selected }: NodeProps<BuilderNode>) {
  const { styles, cx } = useStyles();
  const meta = NODE_CATALOG[data.nodeType];
  const issues = useNodeIssues(id);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const exits = resolveExits(data.nodeType, data.config);
  const summary = summarizeNode(data.nodeType, data.config);

  const badge =
    errors.length > 0 ? (
      <Tooltip title={errors.map((e) => e.message).join('\n')}>
        <Badge count={errors.length} size="small" />
      </Tooltip>
    ) : warnings.length > 0 ? (
      <Tooltip title={warnings.map((w) => w.message).join('\n')}>
        <Badge count={warnings.length} size="small" color="orange" />
      </Tooltip>
    ) : null;

  return (
    <div
      className={cx(styles.node, selected && styles.selected, errors.length > 0 && styles.errored)}
    >
      {meta.hasTarget && <Handle type="target" position={Position.Top} />}

      <div className={styles.header} style={{ color: meta.color }}>
        <span>{meta.icon}</span>
        <span style={{ color: 'inherit', flex: 1 }}>{meta.label}</span>
        {badge}
      </div>
      <div className={styles.body}>
        {summary || <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>{meta.hint}</Typography.Text>}
      </div>

      {meta.hasSource &&
        exits.map((exit, i) => {
          const left = exits.length === 1 ? 50 : ((i + 1) / (exits.length + 1)) * 100;
          const isDefault = exit.id === 'out';
          return (
            <div key={exit.id}>
              <Handle
                id={exit.id}
                type="source"
                position={Position.Bottom}
                style={{ left: `${left}%` }}
              />
              {!isDefault && exit.label && (
                <span className={styles.exitLabel} style={{ left: `${left}%` }}>
                  {exit.label}
                </span>
              )}
            </div>
          );
        })}
    </div>
  );
}

// nodeTypes maps every FlowNodeType to the shared card.
const nodeTypes = Object.fromEntries(
  (Object.keys(NODE_CATALOG) as FlowNodeType[]).map((t) => [t, FlowNodeCard]),
) as Record<FlowNodeType, typeof FlowNodeCard>;

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

interface FlowCanvasProps {
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  issuesByNode: Record<string, FlowIssue[]>;
  editable: boolean;
  onNodesChange: (changes: NodeChange<BuilderNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<BuilderEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectNode: (nodeId: string | null) => void;
  /** Drop a palette node at a flow position. */
  onDropNode: (type: FlowNodeType, position: { x: number; y: number }) => void;
}

function CanvasInner({
  nodes,
  edges,
  editable,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectNode,
  onDropNode,
}: Omit<FlowCanvasProps, 'issuesByNode'>) {
  const [instance, setInstance] = useState<ReactFlowInstance<BuilderNode, BuilderEdge> | null>(null);

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData(DND_MIME) as FlowNodeType;
    if (!type || !instance) return;
    const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    onDropNode(type, position);
  };

  return (
    <ReactFlow<BuilderNode, BuilderEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={setInstance}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={handleDrop}
      nodesDraggable={editable}
      nodesConnectable={editable}
      elementsSelectable
      deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => NODE_CATALOG[(n.data as FlowNodeData).nodeType]?.color ?? '#999'}
      />
    </ReactFlow>
  );
}

export function FlowCanvas({ issuesByNode, ...rest }: FlowCanvasProps) {
  const ctx = useMemo(() => issuesByNode, [issuesByNode]);
  return (
    <IssuesContext.Provider value={ctx}>
      <ReactFlowProvider>
        <CanvasInner {...rest} />
      </ReactFlowProvider>
    </IssuesContext.Provider>
  );
}

export type { Connection, Edge };
