'use client';

import { useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Flex, Input, Space, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { LocaleSelect, TierTag } from '@/components/common/LocaleSelect';
import { getLocale, localeLabel } from '@/lib/locales';
import { SUGGESTED_DISCLOSURE } from '@/features/settings/jurisdictions';

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    padding: 10px 12px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
  `,
  script: css`
    padding: 12px 14px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    border-left: 3px solid ${token.colorPrimary};
    font-size: 14px;
    line-height: 1.65;
  `,
  speaker: css`
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${token.colorTextTertiary};
  `,
}));

export interface DisclosureEditorProps {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  /** When disclosure is off, the editor stays visible but explains that nothing is spoken. */
  enabled: boolean;
  disabled?: boolean;
}

/**
 * Per-locale AI disclosure text, with a preview of the actual call opening.
 *
 * The wording is legally load-bearing (EU AI Act transparency obligation), which
 * is why it is a reviewed string rather than something the model paraphrases per
 * call — and why the operator gets to read exactly what will be said, in every
 * language they operate in, before it goes out.
 */
export function DisclosureEditor({ value, onChange, enabled, disabled }: DisclosureEditorProps) {
  const { styles } = useStyles();
  const locales = Object.keys(value).sort();
  const [previewLocale, setPreviewLocale] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const active = previewLocale && value[previewLocale] !== undefined ? previewLocale : locales[0];

  const setText = (locale: string, text: string) => onChange({ ...value, [locale]: text });

  const addLocale = (locale: string) => {
    onChange({ ...value, [locale]: SUGGESTED_DISCLOSURE[locale] ?? '' });
    setPreviewLocale(locale);
    setAdding(false);
  };

  const removeLocale = (locale: string) => {
    const next = { ...value };
    delete next[locale];
    onChange(next);
    if (previewLocale === locale) setPreviewLocale(null);
  };

  return (
    <Flex vertical gap={12}>
      {!enabled && (
        <Alert
          type="warning"
          showIcon
          message="Disclosure is turned off — none of this text is spoken"
          description="Every jurisdiction this platform supports expects a caller to be told they are talking to a machine. Leaving it off is a decision you should be able to defend to a regulator."
        />
      )}

      {locales.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No disclosure text yet. Add the language your callers actually speak."
        />
      ) : (
        <Flex vertical gap={8}>
          {locales.map((locale) => {
            const info = getLocale(locale);
            const empty = !value[locale]?.trim();
            return (
              <div key={locale} className={styles.row}>
                <Flex justify="space-between" align="center" gap={8} style={{ marginBottom: 6 }}>
                  <Space size={6}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {localeLabel(locale)}
                    </Typography.Text>
                    <Tag bordered={false}>{locale}</Tag>
                    {info && <TierTag tier={info.tier} />}
                  </Space>
                  <Space size={4}>
                    <Button
                      size="small"
                      type={active === locale ? 'primary' : 'text'}
                      onClick={() => setPreviewLocale(locale)}
                    >
                      Preview
                    </Button>
                    {SUGGESTED_DISCLOSURE[locale] &&
                      value[locale] !== SUGGESTED_DISCLOSURE[locale] && (
                        <Tooltip title="Replace with the reviewed wording from our message catalogue.">
                          <Button
                            size="small"
                            type="text"
                            disabled={disabled}
                            onClick={() => setText(locale, SUGGESTED_DISCLOSURE[locale]!)}
                          >
                            Use ours
                          </Button>
                        </Tooltip>
                      )}
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={disabled}
                      onClick={() => removeLocale(locale)}
                    />
                  </Space>
                </Flex>
                <Input.TextArea
                  value={value[locale]}
                  disabled={disabled}
                  onChange={(e) => setText(locale, e.target.value)}
                  rows={2}
                  status={empty ? 'warning' : undefined}
                  placeholder="What the agent says at the very start of the call."
                />
                {empty && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    Empty — a caller in this language would hear no disclosure at all.
                  </Typography.Text>
                )}
              </div>
            );
          })}
        </Flex>
      )}

      {adding ? (
        <Flex gap={8}>
          <LocaleSelect
            style={{ flex: 1 }}
            placeholder="Add a language"
            exclude={locales}
            autoFocus
            onChange={(v) => addLocale(v as string)}
          />
          <Button onClick={() => setAdding(false)}>Cancel</Button>
        </Flex>
      ) : (
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setAdding(true)}
          disabled={disabled}
          style={{ alignSelf: 'flex-start' }}
        >
          Add a language
        </Button>
      )}

      {active && (
        <Flex vertical gap={6}>
          <span className={styles.speaker}>What the caller hears — {localeLabel(active)}</span>
          <div className={styles.script}>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              Call connects · agent speaks first
            </Typography.Text>
            <Typography.Text>
              {value[active]?.trim() || (
                <Typography.Text type="secondary">(nothing — this locale is blank)</Typography.Text>
              )}
            </Typography.Text>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
              …then the agent’s own greeting from its prompt.
            </Typography.Paragraph>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Spoken in the formal register regardless of the agent’s configured register — this is a
            legal statement, and “du” or “tu” in a compliance notice reads badly in every language
            that distinguishes them.
          </Typography.Text>
        </Flex>
      )}
    </Flex>
  );
}
