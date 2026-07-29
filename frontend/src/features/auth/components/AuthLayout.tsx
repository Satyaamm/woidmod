'use client';

import type { ReactNode } from 'react';
import { CheckCircleFilled } from '@ant-design/icons';
import { Flex, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { Logo } from '@/components/brand/Logo';

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    background: ${token.colorBgContainer};

    @media (max-width: 900px) {
      grid-template-columns: 1fr;
    }
  `,
  left: css`
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 48px;
    @media (max-width: 900px) {
      padding: 32px 24px;
    }
  `,
  form: css`
    width: 100%;
    max-width: 372px;
    margin: 0 auto;
  `,
  right: css`
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(120% 90% at 85% 15%, ${token.colorPrimary}26 0%, transparent 60%),
      radial-gradient(90% 70% at 15% 90%, ${token.colorPrimary}1a 0%, transparent 55%),
      ${token.colorBgLayout};
    border-left: 1px solid ${token.colorBorderSecondary};
    display: flex;
    align-items: center;
    padding: 56px;

    @media (max-width: 900px) {
      display: none;
    }
  `,
  pitch: css`
    max-width: 420px;
    h2 {
      font-size: 32px;
      line-height: 1.15;
      letter-spacing: -0.03em;
      margin: 0 0 14px;
    }
  `,
  tick: css`
    color: ${token.colorPrimary};
    font-size: 15px;
    margin-top: 2px;
    flex: none;
  `,
  bars: css`
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 44px;
    margin-bottom: 28px;
  `,
  bar: css`
    width: 4px;
    border-radius: 2px;
    background: linear-gradient(180deg, ${token.colorPrimary} 0%, ${token.colorPrimary}55 100%);
  `,
  brandRow: css`
    margin-bottom: 40px;
  `,
}));

const WAVE = [10, 22, 36, 18, 44, 28, 14, 34, 24, 40, 16, 30, 12, 26, 20, 38, 8, 22, 32, 12];

/**
 * What the panel says now, and why it isn't three big numbers.
 *
 * It used to read "320 ms median response · 60 s signup to first call · 100k
 * concurrent calls". None of those were measured — there was no telemetry behind
 * them and no deployment they described. Invented benchmarks on a login page are
 * the cheapest kind of lie and the first thing a technical buyer checks, so they
 * are gone.
 *
 * These four are claims the repository can actually back: each maps to shipped
 * code (semantic endpointing, the video pipeline, BYOK with live verification,
 * the audit log and RBAC). If a capability is removed, this list is wrong and
 * should change with it.
 */
const CAPABILITIES = [
  {
    title: 'Voice and video, one agent',
    detail:
      'Answer a phone call, then escalate to a live video meeting the agent joins as a participant — seeing, speaking, and on screen.',
  },
  {
    title: 'Conversation that holds up',
    detail:
      'Turn-taking from meaning rather than a silence timer, interruption handled to the exact word heard, and no dead air over a slow lookup.',
  },
  {
    title: 'Your provider accounts',
    detail:
      'Bring your own keys for 21 speech and language providers, or any OpenAI-compatible gateway. Your billing, your DPA, your region.',
  },
  {
    title: 'Answerable in a security review',
    detail:
      'Per-tenant encryption, a hash-chained audit log, row-level tenant isolation, and a 38-permission role catalog.',
  },
];

/**
 * Split auth layout. Left = form, right = the pitch. Marketing-grade polish here
 * is deliberate — it's the first thing anyone sees (docs/09 step 2).
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const { styles } = useStyles();

  return (
    <div className={styles.page}>
      <div className={styles.left}>
        <div className={styles.form}>
          <div className={styles.brandRow}>
            <Logo />
          </div>
          <Typography.Title level={2} style={{ marginBottom: subtitle ? 6 : 22 }}>
            {title}
          </Typography.Title>
          {subtitle && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 26 }}>
              {subtitle}
            </Typography.Paragraph>
          )}
          {children}
        </div>
      </div>

      <div className={styles.right}>
        <div className={styles.pitch}>
          <div className={styles.bars} aria-hidden>
            {WAVE.map((h, i) => (
              <span key={i} className={styles.bar} style={{ height: h }} />
            ))}
          </div>
          <Typography.Title level={2}>
            Agents that answer the phone — and join the video call.
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ fontSize: 14 }}>
            Semantic turn-taking so it doesn&apos;t talk over people, playout-accurate
            barge-in so interrupting works, and an escalation path where the agent joins a
            live meeting, sees a shared screen, and hands off to a human when it should.
          </Typography.Paragraph>
          <Flex vertical gap={12} style={{ marginTop: 28 }}>
            {CAPABILITIES.map((item) => (
              <Flex key={item.title} gap={10} align="flex-start">
                <CheckCircleFilled className={styles.tick} />
                <div>
                  <Typography.Text strong style={{ fontSize: 13.5 }}>
                    {item.title}
                  </Typography.Text>
                  <Typography.Paragraph
                    type="secondary"
                    style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}
                  >
                    {item.detail}
                  </Typography.Paragraph>
                </div>
              </Flex>
            ))}
          </Flex>
        </div>
      </div>
    </div>
  );
}
