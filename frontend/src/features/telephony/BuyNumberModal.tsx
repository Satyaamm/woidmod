'use client';

import { useState } from 'react';
import { SearchOutlined } from '@ant-design/icons';
import { App, Button, Flex, Input, Modal, Select, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CountrySelect, countryName, flag } from '@/components/common/CountrySelect';
import { numberApi } from '@/lib/api';
import type { Agent, AvailableNumber } from '@/lib/contract';
import { formatUsd } from '@/lib/format';
import { CapabilityTags, numberTypeLabel } from './NumberTags';

/**
 * Buy-number flow. Pick a country (plus optional area code / contains), search
 * the upstream inventory via `numberApi.available`, then purchase the selected
 * one via `numberApi.purchase`. `onPurchased` lets the parent re-fetch its list.
 */
export function BuyNumberModal({
  open,
  onClose,
  workspaceId,
  agents,
  onPurchased,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  agents: Agent[];
  onPurchased: () => void;
}) {
  const { message } = App.useApp();

  const [country, setCountry] = useState<string>('US');
  const [areaCode, setAreaCode] = useState('');
  const [contains, setContains] = useState('');
  const [agentId, setAgentId] = useState<string | undefined>(undefined);

  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  const reset = () => {
    setResults(null);
    setSelected(null);
    setAreaCode('');
    setContains('');
    setAgentId(undefined);
  };

  const close = () => {
    reset();
    onClose();
  };

  const search = async () => {
    setSearching(true);
    setSelected(null);
    try {
      const items = await numberApi.available(workspaceId, {
        country,
        areaCode: areaCode.trim() || undefined,
        contains: contains.trim() || undefined,
      });
      setResults(items);
      if (items.length === 0) message.info('No numbers available for that search.');
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const purchase = async () => {
    const chosen = results?.find((n) => n.e164 === selected);
    if (!chosen) return;
    setPurchasing(true);
    try {
      const bought = await numberApi.purchase(workspaceId, {
        e164: chosen.e164,
        country: chosen.country,
        agentId,
      });
      message.success(`${bought.e164} purchased.`);
      onPurchased();
      close();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setPurchasing(false);
    }
  };

  const columns: ColumnsType<AvailableNumber> = [
    {
      title: 'Number',
      dataIndex: 'e164',
      key: 'e164',
      render: (e164: string) => <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{e164}</span>,
    },
    {
      title: 'Location',
      key: 'location',
      render: (_, n) => (
        <Typography.Text type="secondary">
          {[n.locality, n.region].filter(Boolean).join(', ') || '—'}
        </Typography.Text>
      ),
    },
    { title: 'Type', key: 'type', render: (_, n) => numberTypeLabel(n.numberType) },
    {
      title: 'Capabilities',
      key: 'capabilities',
      render: (_, n) => <CapabilityTags capabilities={n.capabilities} />,
    },
    {
      title: 'Monthly',
      key: 'monthly',
      align: 'right',
      render: (_, n) => <span className="tabular">{formatUsd(n.monthlyCostUsd)}</span>,
    },
    {
      title: 'Setup',
      key: 'setup',
      align: 'right',
      render: (_, n) => <span className="tabular">{formatUsd(n.setupCostUsd)}</span>,
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={close}
      title="Buy a number"
      width={760}
      destroyOnHidden
      okText="Buy number"
      okButtonProps={{ disabled: !selected, loading: purchasing }}
      onOk={purchase}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        Search the upstream inventory for {flag(country)} {countryName(country)}, then buy one. You can
        assign it to an agent now or later.
      </Typography.Paragraph>

      <Flex gap={10} wrap align="center" style={{ marginBottom: 12 }}>
        <CountrySelect
          value={country}
          onChange={(c) => {
            setCountry(c);
            setResults(null);
            setSelected(null);
          }}
          style={{ width: 220 }}
        />
        <Input
          placeholder="Area code"
          value={areaCode}
          onChange={(e) => setAreaCode(e.target.value)}
          style={{ width: 130 }}
        />
        <Input
          placeholder="Contains digits"
          value={contains}
          onChange={(e) => setContains(e.target.value)}
          style={{ width: 150 }}
        />
        <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={search}>
          Search
        </Button>
      </Flex>

      {results && (
        <Table<AvailableNumber>
          rowKey="e164"
          size="small"
          columns={columns}
          dataSource={results}
          pagination={false}
          scroll={{ y: 300 }}
          rowSelection={{
            type: 'radio',
            selectedRowKeys: selected ? [selected] : [],
            onChange: (keys) => setSelected((keys[0] as string) ?? null),
          }}
          onRow={(n) => ({ onClick: () => setSelected(n.e164) })}
        />
      )}

      {selected && (
        <Flex align="center" gap={10} style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            Assign to agent (optional)
          </Typography.Text>
          <Select
            allowClear
            showSearch
            size="small"
            placeholder="Leave unassigned"
            style={{ width: 220 }}
            value={agentId}
            optionFilterProp="label"
            onChange={(v) => setAgentId(v ?? undefined)}
            options={agents.map((a) => ({ value: a.id, label: a.name }))}
          />
        </Flex>
      )}
    </Modal>
  );
}
