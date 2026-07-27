'use client';

import { useState } from 'react';
import { App, Select } from 'antd';
import { numberApi } from '@/lib/api';
import type { Agent, PhoneNumber } from '@/lib/contract';

/**
 * Inline agent-assignment control for a single number. A `Select` of the
 * workspace's agents that writes straight through `numberApi.assign` — clearing
 * it un-assigns the number. Calls `onChanged` so the parent can re-fetch.
 */
export function AssignAgentControl({
  number,
  agents,
  workspaceId,
  onChanged,
}: {
  number: PhoneNumber;
  agents: Agent[];
  workspaceId: string;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  const assign = async (agentId: string | null) => {
    setBusy(true);
    try {
      await numberApi.assign(number.id, agentId, workspaceId);
      const name = agentId ? agents.find((a) => a.id === agentId)?.name ?? 'agent' : null;
      message.success(name ? `${number.e164} assigned to ${name}.` : `${number.e164} unassigned.`);
      onChanged();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Select
      allowClear
      showSearch
      size="small"
      placeholder="Assign agent"
      style={{ width: 150 }}
      loading={busy}
      disabled={busy}
      value={number.assignedAgentId ?? undefined}
      optionFilterProp="label"
      onChange={(agentId) => assign(agentId ?? null)}
      options={agents.map((a) => ({ value: a.id, label: a.name }))}
    />
  );
}

/** Read helper: the assigned agent's name, or "Unassigned". */
export function assignedAgentName(agents: Agent[], agentId: string | null): string {
  if (!agentId) return 'Unassigned';
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}
