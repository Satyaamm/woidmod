'use client';

import { useCallback, useMemo, useState } from 'react';
import { CheckCircleOutlined, SaveOutlined, WarningOutlined } from '@ant-design/icons';
import {
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { App, Badge, Button, Card, Flex, Select, Space, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { Agent, AgentModality, FlowNodeType, FlowSpec } from '@/lib/contract';
import { agentApi } from '@/lib/api';
import { FlowCanvas } from './FlowCanvas';
import { NodePalette } from './NodePalette';
import { NodeConfigPanel } from './NodeConfigPanel';
import { NODE_CATALOG } from './nodeCatalog';
import { fromFlowSpec, newEdgeId, newNodeId, toFlowSpec, type BuilderEdge, type BuilderNode } from './compile';
import { useFlowValidation } from './useFlowValidation';

const useStyles = createStyles(({ token, css }) => ({
  canvasWrap: css`
    height: 70vh;
    min-height: 480px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    overflow: hidden;
    background: ${token.colorBgLayout};
  `,
  paletteWrap: css`
    width: 220px;
    flex: 0 0 220px;
    height: 70vh;
    min-height: 480px;
  `,
}));

/** A fresh Start → End graph, matching backend `emptyFlow`. */
function seedFlow(): FlowSpec {
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

export function FlowTab({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { styles } = useStyles();
  const { message } = App.useApp();

  const initial = useMemo(() => fromFlowSpec(agent.flow ?? seedFlow()), [agent.flow]);

  const [nodes, setNodes, onNodesChange] = useNodesState<BuilderNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<BuilderEdge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modality, setModality] = useState<AgentModality>(agent.modality);
  const [saving, setSaving] = useState(false);

  const entryNodeId = useMemo(
    () => nodes.find((n) => n.data.nodeType === 'start')?.id ?? 'start',
    [nodes],
  );

  const { issuesByNode, errorCount, warningCount, validating } = useFlowValidation(
    agent.id,
    nodes,
    edges,
    entryNodeId,
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  // -- Graph edits ----------------------------------------------------------

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable) return;
      setEdges((eds) =>
        addEdge<BuilderEdge>(
          { ...connection, id: newEdgeId(), sourceHandle: connection.sourceHandle ?? 'out' } as Edge,
          eds,
        ),
      );
    },
    [editable, setEdges],
  );

  const addNode = useCallback(
    (type: FlowNodeType, position: { x: number; y: number }) => {
      if (!editable) return;
      const id = newNodeId();
      const node: BuilderNode = {
        id,
        type,
        position,
        data: { nodeType: type, config: NODE_CATALOG[type].defaultData() },
      };
      setNodes((nds) => [...nds, node]);
      setSelectedId(id);
    },
    [editable, setNodes],
  );

  // Click-to-add drops near the centre with a slight cascade so nodes don't stack.
  const addNodeFromPalette = useCallback(
    (type: FlowNodeType) => {
      const offset = nodes.length * 28;
      addNode(type, { x: 220 + (offset % 160), y: 80 + offset });
    },
    [addNode, nodes.length],
  );

  const updateSelectedConfig = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selectedId) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedId
            ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } }
            : n,
        ),
      );
    },
    [selectedId, setNodes],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, setEdges, setNodes]);

  // -- Save -----------------------------------------------------------------

  const handleSave = useCallback(async () => {
    const spec = toFlowSpec(nodes, edges, entryNodeId);
    setSaving(true);
    try {
      await agentApi.update(agent.id, { flow: spec, modality });
      message.success('Flow saved');
    } catch {
      message.error('Could not save the flow');
    } finally {
      setSaving(false);
    }
  }, [agent.id, edges, entryNodeId, modality, nodes, message]);

  const saveDisabled = !editable || saving || errorCount > 0;

  // -- Render ---------------------------------------------------------------

  return (
    <Flex vertical gap={12}>
      <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
        <Flex align="center" justify="space-between" gap={12} wrap>
          <Space size="middle" wrap>
            <Space size={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Modality
              </Typography.Text>
              <Select<AgentModality>
                size="small"
                value={modality}
                onChange={setModality}
                disabled={!editable}
                style={{ width: 140 }}
                options={[
                  { value: 'voice', label: 'Voice only' },
                  { value: 'video', label: 'Video' },
                  { value: 'both', label: 'Voice + Video' },
                ]}
              />
            </Space>

            <ValidationSummary
              errorCount={errorCount}
              warningCount={warningCount}
              validating={validating}
            />
          </Space>

          <Tooltip title={errorCount > 0 ? 'Fix the errors before saving' : undefined}>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={saveDisabled}
              onClick={handleSave}
            >
              Save flow
            </Button>
          </Tooltip>
        </Flex>
      </Card>

      <Flex gap={12} align="stretch">
        {editable && (
          <div className={styles.paletteWrap}>
            <Card size="small" title="Nodes" styles={{ body: { padding: 8, height: 'calc(100% - 40px)' } }} style={{ height: '100%' }}>
              <NodePalette modality={modality} editable={editable} onAdd={addNodeFromPalette} />
            </Card>
          </div>
        )}

        <div className={styles.canvasWrap} style={{ flex: 1 }}>
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            issuesByNode={issuesByNode}
            editable={editable}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectNode={setSelectedId}
            onDropNode={addNode}
          />
        </div>
      </Flex>

      <NodeConfigPanel
        node={selectedNode}
        tools={agent.tools}
        issues={selectedId ? issuesByNode[selectedId] ?? [] : []}
        editable={editable}
        onClose={() => setSelectedId(null)}
        onChange={updateSelectedConfig}
        onDelete={deleteSelected}
      />
    </Flex>
  );
}

function ValidationSummary({
  errorCount,
  warningCount,
  validating,
}: {
  errorCount: number;
  warningCount: number;
  validating: boolean;
}) {
  if (validating && errorCount === 0 && warningCount === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Validating…
      </Typography.Text>
    );
  }
  if (errorCount === 0 && warningCount === 0) {
    return (
      <Space size={6}>
        <CheckCircleOutlined style={{ color: 'var(--ant-color-success)' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          No issues
        </Typography.Text>
      </Space>
    );
  }
  return (
    <Space size={12}>
      {errorCount > 0 && (
        <Badge
          count={errorCount}
          size="small"
          offset={[4, 0]}
        >
          <Space size={4}>
            <WarningOutlined style={{ color: 'var(--ant-color-error)' }} />
            <Typography.Text style={{ fontSize: 12 }}>
              {errorCount} error{errorCount === 1 ? '' : 's'}
            </Typography.Text>
          </Space>
        </Badge>
      )}
      {warningCount > 0 && (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {warningCount} warning{warningCount === 1 ? '' : 's'}
        </Typography.Text>
      )}
    </Space>
  );
}
