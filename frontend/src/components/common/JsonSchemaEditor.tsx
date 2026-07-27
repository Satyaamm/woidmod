'use client';

import { useMemo, useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Flex, Input, Segmented, Select, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CodeEditor, jsonError } from '@/components/common/CodeEditor';
import { EmptyState } from '@/components/common/EmptyState';

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

interface PropertyRow {
  key: string;
  name: string;
  type: JsonSchemaType;
  description: string;
  required: boolean;
  /** Comma-separated in the UI, `enum: []` in the schema. */
  enumValues: string;
}

const TYPE_OPTIONS: JsonSchemaType[] = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };

function schemaToRows(schema: Record<string, unknown>): PropertyRow[] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  return Object.entries(properties).map(([name, def], i) => ({
    key: `${name}_${i}`,
    name,
    type: (def.type as JsonSchemaType) ?? 'string',
    description: (def.description as string) ?? '',
    required: required.includes(name),
    enumValues: Array.isArray(def.enum) ? (def.enum as unknown[]).join(', ') : '',
  }));
}

function rowsToSchema(rows: PropertyRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows) {
    if (!row.name.trim()) continue;
    const def: Record<string, unknown> = { type: row.type };
    if (row.description.trim()) def.description = row.description.trim();
    const values = row.enumValues
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length > 0) {
      def.enum = row.type === 'number' || row.type === 'integer' ? values.map(Number) : values;
    }
    properties[row.name.trim()] = def;
    if (row.required) required.push(row.name.trim());
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * JSON-Schema parameter editor for tool definitions.
 *
 * Two views over the same value: a property table for the 95% case (flat object
 * of scalars, which is all an LLM tool call really wants) and raw JSON for
 * anything nested. The raw view is authoritative — the table just writes to it.
 */
export function JsonSchemaEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: Record<string, unknown>;
  onChange: (schema: Record<string, unknown>) => void;
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<'fields' | 'json'>('fields');
  const [rawDraft, setRawDraft] = useState<string | null>(null);

  const rows = useMemo(() => schemaToRows(value ?? EMPTY_SCHEMA), [value]);
  const pretty = useMemo(() => JSON.stringify(value ?? EMPTY_SCHEMA, null, 2), [value]);
  const raw = rawDraft ?? pretty;
  const rawError = jsonError(raw);

  const setRows = (next: PropertyRow[]) => {
    setRawDraft(null);
    onChange(rowsToSchema(next));
  };

  const patchRow = (key: string, patch: Partial<PropertyRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const columns: ColumnsType<PropertyRow> = [
    {
      title: 'Name',
      dataIndex: 'name',
      width: 180,
      render: (_, row) => (
        <Input
          size="small"
          value={row.name}
          disabled={readOnly}
          placeholder="customer_id"
          onChange={(e) => patchRow(row.key, { name: e.target.value })}
        />
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      width: 116,
      render: (_, row) => (
        <Select<JsonSchemaType>
          size="small"
          value={row.type}
          disabled={readOnly}
          style={{ width: '100%' }}
          options={TYPE_OPTIONS.map((v) => ({ value: v, label: v }))}
          onChange={(v) => patchRow(row.key, { type: v })}
        />
      ),
    },
    {
      title: (
        <Tooltip title="The model reads this to decide what to put in the field. Write it for a reader who cannot see your API docs.">
          <span style={{ borderBottom: '1px dotted currentColor' }}>Description</span>
        </Tooltip>
      ),
      dataIndex: 'description',
      render: (_, row) => (
        <Input
          size="small"
          value={row.description}
          disabled={readOnly}
          placeholder="What this value is, and where it comes from"
          onChange={(e) => patchRow(row.key, { description: e.target.value })}
        />
      ),
    },
    {
      title: 'Allowed values',
      dataIndex: 'enumValues',
      width: 190,
      render: (_, row) => (
        <Input
          size="small"
          value={row.enumValues}
          disabled={readOnly}
          placeholder="comma, separated"
          onChange={(e) => patchRow(row.key, { enumValues: e.target.value })}
        />
      ),
    },
    {
      title: 'Req.',
      dataIndex: 'required',
      width: 58,
      align: 'center',
      render: (_, row) => (
        <Checkbox
          checked={row.required}
          disabled={readOnly}
          onChange={(e) => patchRow(row.key, { required: e.target.checked })}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 40,
      render: (_, row) =>
        readOnly ? null : (
          <Button
            size="small"
            type="text"
            icon={<DeleteOutlined />}
            onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
          />
        ),
    },
  ];

  return (
    <Flex vertical gap={8}>
      <Flex justify="space-between" align="center" gap={8}>
        <Segmented<'fields' | 'json'>
          size="small"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'fields', label: 'Fields' },
            { value: 'json', label: 'JSON Schema' },
          ]}
        />
        {mode === 'fields' && !readOnly && (
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: `new_${Date.now()}`,
                  name: '',
                  type: 'string',
                  description: '',
                  required: false,
                  enumValues: '',
                },
              ])
            }
          >
            Add parameter
          </Button>
        )}
      </Flex>

      {mode === 'fields' ? (
        rows.length === 0 ? (
          <EmptyState
            title="No parameters"
            description="A tool with no parameters is called with an empty object. Add one if the model needs to pass anything through."
            action={
              readOnly ? undefined : (
                <Button
                  size="small"
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() =>
                    setRows([
                      {
                        key: `new_${Date.now()}`,
                        name: '',
                        type: 'string',
                        description: '',
                        required: false,
                        enumValues: '',
                      },
                    ])
                  }
                >
                  Add parameter
                </Button>
              )
            }
          />
        ) : (
          <Table<PropertyRow>
            rowKey="key"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 760 }}
          />
        )
      ) : (
        <Flex vertical gap={6}>
          <CodeEditor
            value={raw}
            readOnly={readOnly}
            minHeight={220}
            onChange={(next) => {
              setRawDraft(next);
              const err = jsonError(next);
              if (!err && next.trim()) onChange(JSON.parse(next) as Record<string, unknown>);
            }}
          />
          {rawError ? (
            <Alert type="error" showIcon message={`Invalid JSON — ${rawError}`} />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              JSON Schema draft 2020-12. Only the object form is supported at the top level — that is what the
              tool-call APIs accept.
            </Typography.Text>
          )}
        </Flex>
      )}
    </Flex>
  );
}
