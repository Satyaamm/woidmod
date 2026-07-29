'use client';

import { useMemo, useState } from 'react';
import { PlayCircleOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Flex, Tag, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { CodeEditor, jsonError } from '@/components/common/CodeEditor';
import { toolApi } from '@/lib/api';
import type { ToolTestResult, WorkspaceTool } from '@/lib/contract';
import { formatMs } from '@/lib/format';
import { gradeLatency } from '@/lib/format';

const useStyles = createStyles(({ token, css }) => ({
  label: css`
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${token.colorTextTertiary};
    margin-bottom: 4px;
  `,
}));

/** Sample arguments derived from the schema, so the panel is useful on first open. */
function sampleArgs(tool: WorkspaceTool): string {
  const props = (tool.parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(props)) {
    const type = def.type as string;
    const enums = def.enum as unknown[] | undefined;
    out[name] = enums?.[0] ?? (type === 'number' || type === 'integer' ? 0 : type === 'boolean' ? true : `<${name}>`);
  }
  return JSON.stringify(out, null, 2);
}

const LATENCY_COLOR = { good: 'green', warn: 'orange', bad: 'red' } as const;

/**
 * Fire the tool with sample arguments and see exactly what came back.
 *
 * The single most common failure in production is a tool that 200s in Postman
 * and 401s from the platform, so the request pane shows the headers the
 * platform would actually send (secrets masked).
 */
export function ToolTestPanel({ tool }: { tool: WorkspaceTool }) {
  const { styles } = useStyles();
  const [args, setArgs] = useState(() => sampleArgs(tool));
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const [running, setRunning] = useState(false);

  const parseError = jsonError(args);
  const requiredHint = useMemo(
    () => ((tool.parameters?.required ?? []) as string[]).join(', '),
    [tool.parameters],
  );

  const run = async () => {
    if (parseError) return;
    setRunning(true);
    try {
      setResult(await toolApi.test(tool.id, JSON.parse(args || '{}') as Record<string, unknown>));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Card
        size="small"
        title="Test run"
        extra={
          <Button
            size="small"
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={running}
            disabled={!!parseError}
            onClick={run}
          >
            Run
          </Button>
        }
      >
        <div className={styles.label}>Arguments{requiredHint && ` · required: ${requiredHint}`}</div>
        <CodeEditor value={args} onChange={setArgs} minHeight={140} maxHeight={260} />
        {parseError && <Alert style={{ marginTop: 8 }} type="error" showIcon message={`Invalid JSON — ${parseError}`} />}
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          The run happens server-side so the workspace's stored secrets are used and never reach the browser. In
          this build the response is a fixture — no request leaves your machine.
        </Typography.Paragraph>
      </Card>

      {result && (
        <>
          <Flex gap={8} wrap align="center">
            <Tag
              bordered={false}
              color={result.status === 'ok' ? 'green' : result.status === 'timeout' ? 'orange' : 'red'}
            >
              {result.status === 'ok' ? `${result.httpStatus} OK` : result.status.toUpperCase()}
            </Tag>
            <Tag bordered={false} color={LATENCY_COLOR[gradeLatency(result.latencyMs)]}>
              {formatMs(result.latencyMs)}
            </Tag>
            {result.latencyMs > tool.timeoutMs && (
              <Tag bordered={false} color="red">
                over the {formatMs(tool.timeoutMs)} timeout — this call would be cut off mid-conversation
              </Tag>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {new Date(result.ranAt).toLocaleTimeString()}
            </Typography.Text>
          </Flex>

          {result.error && <Alert type="error" showIcon message={result.error} />}

          <Card size="small" title="Request">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'm', label: 'Method', children: result.request.method },
                { key: 'u', label: 'URL', children: <Typography.Text code>{result.request.url}</Typography.Text> },
              ]}
              style={{ marginBottom: 8 }}
            />
            <div className={styles.label}>Headers</div>
            <CodeEditor
              value={JSON.stringify(result.request.headers, null, 2)}
              readOnly
              minHeight={80}
              maxHeight={160}
            />
            {result.request.body != null && (
              <>
                <div className={styles.label} style={{ marginTop: 8 }}>
                  Body
                </div>
                <CodeEditor
                  value={JSON.stringify(result.request.body, null, 2)}
                  readOnly
                  minHeight={80}
                  maxHeight={200}
                />
              </>
            )}
          </Card>

          <Card size="small" title="Response">
            {result.response ? (
              <>
                <div className={styles.label}>Headers</div>
                <CodeEditor
                  value={JSON.stringify(result.response.headers, null, 2)}
                  readOnly
                  minHeight={60}
                  maxHeight={140}
                />
                <div className={styles.label} style={{ marginTop: 8 }}>
                  Body — this is verbatim what the model sees
                </div>
                <CodeEditor
                  value={JSON.stringify(result.response.body, null, 2)}
                  readOnly
                  minHeight={120}
                  maxHeight={280}
                />
              </>
            ) : (
              <Typography.Text type="secondary">No response body.</Typography.Text>
            )}
          </Card>
        </>
      )}
    </Flex>
  );
}
