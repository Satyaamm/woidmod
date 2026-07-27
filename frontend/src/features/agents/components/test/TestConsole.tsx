'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AudioMutedOutlined,
  AudioOutlined,
  ExperimentOutlined,
  PhoneOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { Alert, App, Button, Card, Col, Empty, Flex, Input, Progress, Row, Statistic, Tag, Tooltip, Typography } from 'antd';
import { createStyles, useTheme } from 'antd-style';
import { AudioScrubber } from '@/components/common/AudioScrubber';
import { LatencyWaterfall } from '@/components/common/LatencyWaterfall';
import { TraceLanes } from '@/features/calls/components/TraceLanes';
import { TurnInspector } from '@/features/calls/components/TurnInspector';
import { useTraceViewer } from '@/features/calls/lib/useTraceViewer';
import { percentile } from '@/features/calls/lib/trace-model';
import { agentApi } from '@/lib/api';
import { useAsync } from '@/hooks/useAsync';
import type { Track } from 'livekit-client';
import type { Agent, AgentModality, CallTrace, LatencyBreakdown } from '@/lib/contract';
import { gradeLatency } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';
import { LiveTranscript, type LiveLine } from './LiveTranscript';
import { StateMachineView, type StateTransition } from './StateMachineView';
import { VideoStage } from './VideoStage';
import { checkVoiceCapability, createVoiceSession, type VoiceCapability } from './createVoiceSession';
import { useMicrophone } from './useMicrophone';
import type { CallState, VoiceSession, VoiceSessionEvent } from './VoiceSession';

/**
 * The inner dev loop: edit the prompt, talk to the agent, read the trace.
 *
 * docs/07 §3 puts a number on it — **under 10 seconds** from prompt edit to
 * seeing the result — so the trace renders in place when the session ends rather
 * than behind a navigation to the call log.
 *
 * The transport is a `VoiceSession` (see that file). Today it is simulated and
 * says so, loudly, in three places.
 */

const useStyles = createStyles(({ token, css }) => ({
  talk: css`
    height: 108px;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
  `,
  meter: css`
    height: 8px;
    border-radius: 4px;
    background: ${token.colorFillSecondary};
    overflow: hidden;
  `,
  meterFill: css`
    height: 100%;
    background: ${token.colorSuccess};
    transition: width 60ms linear;
  `,
  prompt: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12.5px;
    line-height: 1.6;
  `,
  sparkRow: css`
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 42px;
  `,
  spark: css`
    flex: 1;
    min-width: 3px;
    border-radius: 2px 2px 0 0;
  `,
}));

export function TestConsole({ agent, onAgentChange }: { agent: Agent; onAgentChange: (agent: Agent) => void }) {
  const { styles, theme } = useStyles();
  const { message } = App.useApp();
  const scope = useScope();
  const mic = useMicrophone();

  const sessionRef = useRef<VoiceSession | null>(null);
  const [running, setRunning] = useState(false);
  const [state, setState] = useState<CallState>('IDLE');
  const [transitions, setTransitions] = useState<StateTransition[]>([]);
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [latencies, setLatencies] = useState<LatencyBreakdown[]>([]);
  const [trace, setTrace] = useState<CallTrace | null>(null);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [saving, setSaving] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Video: the agent's own modality decides whether the stage renders at all; the
  // per-session modality (from the grant) and the live tracks drive its contents.
  const videoCapable = agent.modality !== 'voice';
  const [localVideo, setLocalVideo] = useState<Track | null>(null);
  const [remoteVideo, setRemoteVideo] = useState<Track | null>(null);
  const [videoActive, setVideoActive] = useState(false);
  const [sessionModality, setSessionModality] = useState<AgentModality | null>(null);

  useEffect(() => setPrompt(agent.prompt), [agent.prompt]);

  const handleEvent = useCallback((event: VoiceSessionEvent) => {
    switch (event.type) {
      case 'state':
        setState(event.state);
        setTransitions((prev) => [...prev, { state: event.state, trigger: event.trigger, tMs: event.tMs }]);
        break;
      case 'partial':
      case 'final':
        setLines((prev) => {
          const key = `${event.role}-${event.turnIndex}`;
          const next = [...prev];
          const at = next.findIndex((l) => l.key === key);
          const line: LiveLine = {
            key,
            role: event.role,
            text: event.text,
            final: event.type === 'final',
            tMs: event.tMs,
            latencyMs: at >= 0 ? next[at]!.latencyMs : undefined,
            interrupted: at >= 0 ? next[at]!.interrupted : undefined,
          };
          if (at >= 0) next[at] = line;
          else next.push(line);
          return next;
        });
        break;
      case 'turn':
        setLatencies((prev) => [...prev, event.latency]);
        setLines((prev) =>
          prev.map((l) =>
            l.key === `agent-${event.turn.index}` ? { ...l, latencyMs: event.latency.totalMs } : l,
          ),
        );
        break;
      case 'tool':
        setLines((prev) => [
          ...prev,
          {
            key: `tool-${event.name}-${event.tMs}`,
            role: 'system',
            text: event.name,
            final: true,
            tMs: event.tMs,
            tool: { name: event.name, status: event.status, durationMs: event.durationMs },
          },
        ]);
        break;
      case 'filler':
        setLines((prev) => [
          ...prev,
          { key: `filler-${event.tMs}`, role: 'system', text: `filler: “${event.text}”`, final: true, tMs: event.tMs },
        ]);
        break;
      case 'bargein':
        setLines((prev) =>
          prev.map((l) =>
            l.key === `agent-${event.turnIndex}`
              ? { ...l, interrupted: { heardChars: event.heardChars, generatedChars: event.generatedChars } }
              : l,
          ),
        );
        break;
      case 'modality':
        setSessionModality(event.modality);
        break;
      case 'video':
        if (event.source === 'local') {
          setLocalVideo(event.track);
          setVideoActive(event.track != null);
        } else {
          setRemoteVideo(event.track);
        }
        break;
      case 'ended':
        setRunning(false);
        setLocalVideo(null);
        setRemoteVideo(null);
        setVideoActive(false);
        setTrace(sessionRef.current?.getTrace() ?? null);
        break;
      case 'error':
        message.error(event.message);
        setRunning(false);
        break;
      default:
        break;
    }
  }, [message]);

  const [capability, setCapability] = useState<VoiceCapability | null>(null);

  useEffect(() => {
    let live = true;
    void checkVoiceCapability().then((c) => live && setCapability(c));
    return () => {
      live = false;
    };
  }, []);

  const isLive = capability?.available === true;

  // Preflight: is every provider this agent's pipeline needs actually connected?
  // A live call cannot run without STT+LLM+TTS keys, so we block it here with an
  // actionable alert instead of letting the worker connect and die silently. The
  // simulator needs no keys, so it is never blocked.
  const readinessState = useAsync(() => agentApi.readiness(agent.id), [agent.id]);
  const readiness = readinessState.data;
  const missingProviders = readiness?.requirements.filter((r) => !r.connected) ?? [];
  const blocked = isLive && readiness != null && !readiness.ready;

  const start = async () => {
    if (blocked) {
      message.warning('Connect the missing providers before starting a live call.');
      return;
    }
    if (!mic.stream && mic.permission !== 'denied' && mic.permission !== 'unsupported') {
      await mic.request();
    }
    setLines([]);
    setTransitions([]);
    setLatencies([]);
    setTrace(null);
    setLocalVideo(null);
    setRemoteVideo(null);
    setVideoActive(false);
    setSessionModality(null);
    setStartedAt(performance.now());

    const session = createVoiceSession(isLive);
    sessionRef.current = session;
    session.subscribe(handleEvent);
    setRunning(true);
    await session.start({ agentId: agent.id, prompt, micStream: mic.stream });
  };

  const stop = async () => {
    await sessionRef.current?.stop('hangup');
    setRunning(false);
    setTrace(sessionRef.current?.getTrace() ?? null);
  };

  useEffect(
    () => () => {
      void sessionRef.current?.stop('unmounted');
    },
    [],
  );

  const toggleVideo = async () => {
    const session = sessionRef.current;
    // Feature-detect: only the WebRTC transport implements video. The simulator
    // has no camera path, so the control is inert there.
    if (!session?.startVideo || !session.stopVideo) {
      message.info('Video is only available on a live call.');
      return;
    }
    try {
      if (videoActive) await session.stopVideo();
      else await session.startVideo();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const savePrompt = async () => {
    setSaving(true);
    try {
      const updated = await agentApi.update(agent.id, { prompt });
      onAgentChange(updated);
      message.success('Prompt saved. Run the test again to hear the difference.');
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveAndRun = async () => {
    await savePrompt();
    await start();
  };

  const totals = latencies.map((l) => l.totalMs);
  const p50 = percentile(totals, 50);
  const p95 = percentile(totals, 95);
  const last = latencies[latencies.length - 1] ?? null;
  const cacheHits = latencies.filter((l) => l.prefixCacheHit).length;
  const dirty = prompt !== agent.prompt;
  const elapsedSec = startedAt ? (performance.now() - startedAt) / 1000 : 0;

  const gradeOf = (ms: number) =>
    ({ good: theme.colorSuccess, warn: theme.colorWarning, bad: theme.colorError })[gradeLatency(ms)];

  return (
    <Flex vertical gap={12}>
      <Alert
        showIcon
        icon={<ExperimentOutlined />}
        type={isLive ? 'success' : 'warning'}
        message={
          isLive
            ? 'Live call — real audio, real providers'
            : 'Simulated session — live calling is not available'
        }
        description={
          isLive ? (
            <>
              Your microphone is captured and transmitted over WebRTC to the agent worker, which runs
              the real endpointer, speculative prefill and barge-in truncation. Talk over the agent to
              interrupt it — every latency figure below is measured, not modelled.
            </>
          ) : (
            <>
              {capability?.reason ?? 'Checking\u2026'} Until then this console drives a{' '}
              <Typography.Text code>VoiceSession</Typography.Text> that replays a generated trace in
              real time, with the real latency model, state machine and barge-in bookkeeping. Your
              microphone is genuinely captured for the level meter and permission flow \u2014 the audio
              is not transmitted anywhere.
            </>
          )
        }
      />

      {blocked && (
        <Alert
          showIcon
          type="error"
          message="Connect providers before you can call"
          description={
            <>
              This agent&rsquo;s pipeline needs these connected under{' '}
              <b>Settings &rarr; Providers</b> first:
              <ul style={{ margin: '8px 0 6px 18px' }}>
                {missingProviders.map((r) => (
                  <li key={r.providerKey}>
                    {r.capability} &mdash; <Typography.Text code>{r.providerKey}</Typography.Text> not connected
                  </li>
                ))}
              </ul>
              <Link href={wsPath(scope, 'providers')}>Connect providers &rarr;</Link>
            </>
          }
        />
      )}

      {videoCapable && (
        <Card size="small" styles={{ body: { padding: 12 } }}>
          <VideoStage
            agentName={agent.name}
            modality={sessionModality ?? agent.modality}
            running={running}
            localTrack={localVideo}
            remoteTrack={remoteVideo}
            videoActive={videoActive}
            canToggle={running && isLive}
            onToggleVideo={() => void toggleVideo()}
          />
        </Card>
      )}

      <Row gutter={[12, 12]}>
        {/* ---- talk + mic ---- */}
        <Col xs={24} lg={7}>
          <Flex vertical gap={12}>
            <Card size="small" styles={{ body: { padding: 12 } }}>
              <Button
                block
                className={styles.talk}
                type={running ? 'default' : 'primary'}
                danger={running}
                disabled={blocked && !running}
                icon={running ? <StopOutlined /> : <PhoneOutlined />}
                onClick={running ? stop : start}
              >
                {running ? 'End session' : blocked ? 'Providers not connected' : 'Talk to your agent'}
              </Button>

              <Flex vertical gap={6} style={{ marginTop: 12 }}>
                <Flex align="center" justify="space-between">
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {mic.permission === 'granted' ? (
                      <>
                        <AudioOutlined /> {mic.deviceLabel ?? 'Microphone live'}
                      </>
                    ) : (
                      <>
                        <AudioMutedOutlined /> Microphone {mic.permission}
                      </>
                    )}
                  </Typography.Text>
                  {mic.permission !== 'granted' && (
                    <Button size="small" onClick={() => void mic.request()} disabled={mic.permission === 'unsupported'}>
                      Enable mic
                    </Button>
                  )}
                </Flex>
                <div className={styles.meter}>
                  <div className={styles.meterFill} style={{ width: `${Math.round(mic.level * 100)}%` }} />
                </div>
                {mic.error && (
                  <Typography.Text type="danger" style={{ fontSize: 11.5 }}>
                    {mic.error}
                  </Typography.Text>
                )}
              </Flex>

              <Flex gap={8} style={{ marginTop: 12 }}>
                <Tooltip title="Interrupt the agent mid-sentence. This exercises the barge-in path: TTS and generation are cancelled and the context is truncated to exactly what was played out.">
                  <Button
                    block
                    disabled={!running}
                    onClick={() => sessionRef.current?.interrupt()}
                    icon={<ThunderboltFilled />}
                  >
                    Interrupt
                  </Button>
                </Tooltip>
                <Button block disabled={!running} icon={<ReloadOutlined />} onClick={() => void start()}>
                  Restart
                </Button>
              </Flex>
            </Card>

            <Card size="small" title="State machine">
              <StateMachineView current={state} transitions={transitions} />
            </Card>
          </Flex>
        </Col>

        {/* ---- transcript ---- */}
        <Col xs={24} lg={10}>
          <Card
            size="small"
            title="Live transcript"
            extra={
              running ? (
                <Tag bordered={false} color="processing">
                  {elapsedSec.toFixed(0)}s · {state}
                </Tag>
              ) : (
                <Tag bordered={false}>idle</Tag>
              )
            }
            styles={{ body: { padding: 8 } }}
          >
            <LiveTranscript lines={lines} />
          </Card>
        </Col>

        {/* ---- latency ---- */}
        <Col xs={24} lg={7}>
          <Flex vertical gap={12}>
            <Card size="small" title="Latency, live">
              <Row gutter={8}>
                <Col span={8}>
                  <Statistic
                    title="p50"
                    value={p50 || 0}
                    suffix="ms"
                    valueStyle={{ fontSize: 20, color: totals.length ? gradeOf(p50) : undefined }}
                  />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="p95"
                    value={p95 || 0}
                    suffix="ms"
                    valueStyle={{ fontSize: 20, color: totals.length ? gradeOf(p95) : undefined }}
                  />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="Cache"
                    value={latencies.length ? Math.round((cacheHits / latencies.length) * 100) : 0}
                    suffix="%"
                    valueStyle={{ fontSize: 20 }}
                  />
                </Col>
              </Row>

              <div className={styles.sparkRow} style={{ marginTop: 10 }}>
                {totals.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    Turn latencies appear here as they complete.
                  </Typography.Text>
                ) : (
                  totals.map((ms, i) => (
                    <Tooltip key={i} title={`Turn ${i + 1} · ${ms}ms`}>
                      <div
                        className={styles.spark}
                        style={{
                          height: `${Math.max(8, (ms / Math.max(600, ...totals)) * 100)}%`,
                          background: gradeOf(ms),
                        }}
                      />
                    </Tooltip>
                  ))
                )}
              </div>
            </Card>

            <Card size="small" title="Last turn">
              {last ? (
                <LatencyWaterfall latency={last} />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No completed agent turn yet."
                />
              )}
            </Card>
          </Flex>
        </Col>
      </Row>

      {/* ---- prompt ---- */}
      <Card
        size="small"
        title="Prompt"
        extra={
          <Flex gap={8}>
            {dirty && (
              <Tag bordered={false} color="orange">
                unsaved
              </Tag>
            )}
            <Button size="small" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={() => void savePrompt()}>
              Save
            </Button>
            <Button size="small" type="primary" icon={<PhoneOutlined />} loading={saving} onClick={() => void saveAndRun()}>
              Save &amp; test
            </Button>
          </Flex>
        }
      >
        <Input.TextArea
          className={styles.prompt}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 12 }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          Save &amp; test is the inner loop: the edit is persisted and a fresh session starts against it —
          the whole round trip should stay under ten seconds.
        </Typography.Text>
      </Card>

      {/* ---- trace of the session just finished ---- */}
      {trace && !running && <SessionTrace trace={trace} agentId={agent.id} scopeHref={wsPath(scope, 'calls')} />}
    </Flex>
  );
}

/**
 * The same canvas the call trace viewer uses, rendered in place the moment the
 * session ends — so "see the trace" costs zero navigations.
 */
function SessionTrace({ trace, agentId, scopeHref }: { trace: CallTrace; agentId: string; scopeHref: string }) {
  const viewer = useTraceViewer(trace, { syncUrl: false });
  const token = useTheme();
  const marks = useMemo(
    () => [
      ...trace.turns.map((t) => ({ tMs: t.startMs, kind: 'turn' as const })),
      ...viewer.outliers.map((t) => ({ tMs: t.startMs, kind: 'outlier' as const })),
      ...viewer.model.bargeIns.map((b) => ({ tMs: b.atMs, kind: 'bargein' as const })),
    ],
    [trace.turns, viewer.outliers, viewer.model.bargeIns],
  );

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={10}>
          <span>Session trace</span>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            p50 {viewer.model.p50Ms}ms · p95 {viewer.model.p95Ms}ms · {trace.turns.length} turns
          </Typography.Text>
        </Flex>
      }
      extra={
        <Link href={scopeHref}>
          <Button size="small">Open the call log</Button>
        </Link>
      }
      styles={{ body: { padding: 10 } }}
    >
      <Flex vertical gap={10}>
        <AudioScrubber
          durationMs={viewer.model.durationMs}
          playheadMs={viewer.playheadMs}
          playing={viewer.playing}
          onPlayToggle={viewer.togglePlay}
          onSeek={viewer.seek}
          view={viewer.view}
          onViewChange={viewer.setView}
          waveform={trace.waveform}
          marks={marks}
          speed={viewer.speed}
          onSpeedChange={viewer.setSpeed}
        />
        <TraceLanes
          trace={trace}
          model={viewer.model}
          view={viewer.view}
          onViewChange={viewer.setView}
          playheadMs={viewer.playheadMs}
          onSeek={viewer.seek}
          selectedTurn={viewer.selectedTurn}
          onSelectTurn={viewer.selectTurn}
          outlierThresholdMs={viewer.outlierThresholdMs}
        />
        <Row gutter={[10, 10]}>
          <Col xs={24} xl={12}>
            <TurnInspector turn={viewer.selectedTurnData} onSeek={viewer.seek} />
          </Col>
          <Col xs={24} xl={12}>
            <Card size="small" title="Turn latencies">
              {viewer.model.agentTurns.map((turn) => (
                <Flex key={turn.index} align="center" gap={10} style={{ marginBottom: 8 }}>
                  <Typography.Link style={{ fontSize: 11.5, minWidth: 52 }} onClick={() => viewer.selectTurn(turn.index)}>
                    turn #{turn.index + 1}
                  </Typography.Link>
                  <Progress
                    percent={Math.min(100, ((turn.latency?.totalMs ?? 0) / 900) * 100)}
                    showInfo={false}
                    size="small"
                    strokeColor={
                      {
                        good: token.colorSuccess,
                        warn: token.colorWarning,
                        bad: token.colorError,
                      }[gradeLatency(turn.latency?.totalMs ?? 0)]
                    }
                  />
                  <Typography.Text className="tabular" style={{ fontSize: 11.5, minWidth: 52, textAlign: 'right' }}>
                    {turn.latency?.totalMs} ms
                  </Typography.Text>
                </Flex>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                Agent {agentId} · every bar links to the turn that produced it.
              </Typography.Text>
            </Card>
          </Col>
        </Row>
      </Flex>
    </Card>
  );
}
