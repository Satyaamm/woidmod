'use client';

import type { DragEvent } from 'react';
import { Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { AgentModality, FlowNodeType } from '@/lib/contract';
import { DND_MIME } from './FlowCanvas';
import { CATEGORIES, CATEGORY_ORDER, NODE_CATALOG, isVideoNode } from './nodeCatalog';

const useStyles = createStyles(({ token, css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 4px;
    overflow-y: auto;
    height: 100%;
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  groupTitle: css`
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${token.colorTextTertiary};
    padding: 0 4px;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    cursor: grab;
    font-size: 12.5px;
    user-select: none;
    transition: border-color 0.15s, background 0.15s;

    &:hover {
      border-color: ${token.colorPrimary};
      background: ${token.colorPrimaryBg};
    }
  `,
  disabled: css`
    opacity: 0.45;
    cursor: not-allowed;
    &:hover {
      border-color: ${token.colorBorderSecondary};
      background: ${token.colorBgContainer};
    }
  `,
  itemHint: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
}));

interface NodePaletteProps {
  modality: AgentModality;
  editable: boolean;
  onAdd: (type: FlowNodeType) => void;
}

export function NodePalette({ modality, editable, onAdd }: NodePaletteProps) {
  const { styles, cx } = useStyles();
  const videoOk = modality === 'video' || modality === 'both';

  const onDragStart = (event: DragEvent, type: FlowNodeType, disabled: boolean) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(DND_MIME, type);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className={styles.wrap}>
      {CATEGORY_ORDER.map((category) => {
        const items = Object.values(NODE_CATALOG).filter(
          // Start is seeded, never added from the palette.
          (m) => m.category === category && m.type !== 'start',
        );
        if (items.length === 0) return null;

        return (
          <div key={category} className={styles.group}>
            <div className={styles.groupTitle}>{CATEGORIES[category].label}</div>
            {items.map((meta) => {
              const videoBlocked = isVideoNode(meta.type) && !videoOk;
              const disabled = !editable || videoBlocked;
              const tip = videoBlocked
                ? 'Set modality to Video or Both to use this node'
                : meta.hint;

              return (
                <Tooltip key={meta.type} title={tip} placement="right">
                  <div
                    className={cx(styles.item, disabled && styles.disabled)}
                    draggable={!disabled}
                    onDragStart={(e) => onDragStart(e, meta.type, disabled)}
                    onClick={() => !disabled && onAdd(meta.type)}
                    role="button"
                    aria-disabled={disabled}
                  >
                    <span style={{ color: meta.color, fontSize: 15 }}>{meta.icon}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                      <span>{meta.label}</span>
                      <Typography.Text className={styles.itemHint} ellipsis>
                        {meta.hint}
                      </Typography.Text>
                    </div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
