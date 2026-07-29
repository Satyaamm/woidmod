'use client';

import { Flex, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { TURN_STATES, type CallState } from './VoiceSession';

/**
 * Where the call is in the turn state machine, right now.
 *
 * The states and triggers are the ones in
 * `backend/control-plane/src/orchestration/state-machine.ts`. Showing the machine
 * rather than a "thinking…" spinner is the difference between a demo and a tool:
 * when an agent feels wrong it is almost always stuck in a state you can name.
 */

const STATE_HINT: Record<string, string> = {
  GREETING: 'Playing the opening line. Nothing is being transcribed yet.',
  LISTENING: 'Caller has the floor. ASR partials streaming, endpointer scoring every 20ms.',
  SPECULATING: 'P(turn complete) crossed 0.4 — LLM prefill started before the caller stopped.',
  THINKING: 'Turn committed. This is t=0 for the latency measurement.',
  TOOL_CALL: 'Waiting on a tool. Over 500ms a filler covers the gap.',
  FILLER: 'Playing a pre-rendered continuer so the caller is not left in silence.',
  SPEAKING: 'Agent audio playing out. Barge-in is armed.',
  BARGE_IN: 'Caller interrupted. TTS and generation cancelled; context truncated to what was heard.',
  ENDED: 'Call finished.',
  CONNECTING: 'Establishing the session.',
  IDLE: 'No session.',
};

const useStyles = createStyles(({ token, css }) => ({
  chip: css`
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid ${token.colorBorderSecondary};
    font-size: 11px;
    letter-spacing: 0.04em;
    color: ${token.colorTextTertiary};
    background: ${token.colorFillQuaternary};
    white-space: nowrap;
  `,
  active: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
    color: ${token.colorPrimaryText};
    font-weight: 600;
  `,
  alarm: css`
    border-color: ${token.colorError};
    background: ${token.colorErrorBg};
    color: ${token.colorErrorText};
    font-weight: 600;
  `,
  log: css`
    max-height: 132px;
    overflow: auto;
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    line-height: 1.6;
    color: ${token.colorTextTertiary};
  `,
}));

export interface StateTransition {
  state: CallState;
  trigger: string;
  tMs: number;
}

export function StateMachineView({
  current,
  transitions,
}: {
  current: CallState;
  transitions: StateTransition[];
}) {
  const { styles, cx } = useStyles();
  const extra: CallState[] = ['GREETING', 'FILLER', 'BARGE_IN'];
  const chips = [...TURN_STATES, ...extra.filter((s) => !TURN_STATES.includes(s))];

  return (
    <Flex vertical gap={8}>
      <Flex gap={5} wrap="wrap">
        {chips.map((state) => (
          <Tooltip key={state} title={STATE_HINT[state]}>
            <span
              className={cx(
                styles.chip,
                current === state && (state === 'BARGE_IN' ? styles.alarm : styles.active),
              )}
            >
              {state}
            </span>
          </Tooltip>
        ))}
      </Flex>
      <div className={styles.log}>
        {transitions.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Transitions appear here as the call walks the machine.
          </Typography.Text>
        ) : (
          transitions
            .slice(-40)
            .reverse()
            .map((t, i) => (
              <div key={`${t.tMs}-${t.state}-${i}`}>
                {(t.tMs / 1000).toFixed(2).padStart(6, ' ')}s → <strong>{t.state}</strong>{' '}
                <span style={{ opacity: 0.65 }}>({t.trigger})</span>
              </div>
            ))
        )}
      </div>
    </Flex>
  );
}
