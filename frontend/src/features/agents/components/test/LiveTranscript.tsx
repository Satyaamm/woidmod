'use client';

import { useEffect, useRef } from 'react';
import { ApiOutlined, SoundOutlined, WarningFilled } from '@ant-design/icons';
import { Empty, Flex, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { LatencyBadge } from '@/components/common/LatencyBadge';

/**
 * The live conversation as it streams.
 *
 * Partials render in a lighter weight than finals, so you can see the ASR
 * settling rather than text appearing fully formed — that difference is the
 * clearest signal that the pipeline is actually streaming.
 */

const useStyles = createStyles(({ token, css }) => ({
  scroll: css`
    height: 340px;
    overflow: auto;
    padding: 4px 2px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  bubble: css`
    max-width: 88%;
    padding: 7px 11px;
    border-radius: ${token.borderRadiusLG}px;
    font-size: 13px;
    line-height: 1.5;
  `,
  caller: css`
    align-self: flex-start;
    background: ${token.colorFillSecondary};
    border-bottom-left-radius: 3px;
  `,
  agent: css`
    align-self: flex-end;
    background: ${token.colorPrimaryBg};
    border-bottom-right-radius: 3px;
  `,
  partial: css`
    opacity: 0.62;
    font-style: italic;
  `,
  meta: css`
    font-size: 10.5px;
    color: ${token.colorTextQuaternary};
    font-family: ${token.fontFamilyCode};
  `,
  system: css`
    align-self: center;
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
}));

export interface LiveLine {
  key: string;
  role: 'caller' | 'agent' | 'system';
  text: string;
  final: boolean;
  tMs: number;
  latencyMs?: number;
  interrupted?: { heardChars: number; generatedChars: number };
  tool?: { name: string; status: string; durationMs?: number };
}

export function LiveTranscript({ lines }: { lines: LiveLine[] }) {
  const { styles, cx } = useStyles();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  return (
    <div className={styles.scroll}>
      {lines.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Start a session and the conversation streams here, partial by partial."
        />
      )}
      {lines.map((line) => {
        if (line.role === 'system') {
          return (
            <div key={line.key} className={styles.system}>
              {line.tool ? (
                <Tooltip title={`${line.tool.name} · ${line.tool.status}`}>
                  <Tag bordered={false} color={line.tool.status === 'ok' ? 'green' : line.tool.status === 'started' ? 'blue' : 'red'}>
                    <ApiOutlined /> {line.tool.name}
                    {line.tool.durationMs != null ? ` · ${line.tool.durationMs}ms` : '…'}
                  </Tag>
                </Tooltip>
              ) : (
                <Tag bordered={false} color="orange">
                  <SoundOutlined /> {line.text}
                </Tag>
              )}
            </div>
          );
        }
        const heard = line.interrupted?.heardChars;
        return (
          <Flex
            key={line.key}
            vertical
            gap={2}
            style={{ alignSelf: line.role === 'caller' ? 'flex-start' : 'flex-end', maxWidth: '88%' }}
          >
            <div
              className={cx(
                styles.bubble,
                line.role === 'caller' ? styles.caller : styles.agent,
                !line.final && styles.partial,
              )}
            >
              {heard != null ? (
                <>
                  {line.text.slice(0, heard)}
                  <Typography.Text delete type="danger">
                    {line.text.slice(heard)}
                  </Typography.Text>
                </>
              ) : (
                line.text
              )}
            </div>
            <Flex gap={8} align="center" justify={line.role === 'caller' ? 'flex-start' : 'flex-end'}>
              <span className={styles.meta}>{(line.tMs / 1000).toFixed(2)}s</span>
              {line.latencyMs != null && <LatencyBadge ms={line.latencyMs} showDot={false} />}
              {heard != null && (
                <Tooltip title="The caller interrupted. Context was truncated to exactly this many characters — the struck-through text was never heard.">
                  <Typography.Text type="danger" style={{ fontSize: 10.5 }}>
                    <WarningFilled /> heard {heard}/{line.interrupted!.generatedChars}
                  </Typography.Text>
                </Tooltip>
              )}
            </Flex>
          </Flex>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
