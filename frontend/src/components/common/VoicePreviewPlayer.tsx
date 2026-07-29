'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingOutlined, PauseOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons';
import { Button, Flex, Tooltip, Typography } from 'antd';

export type PreviewResult =
  /** Something playable — an object URL, a data URI, or an https URL. */
  | { kind: 'audio'; url: string }
  /** The engine ran, but there is no audio to play (mock provider, no credential). */
  | { kind: 'silent'; reason: string };

export interface VoicePreviewPlayerProps {
  /** Fetches audio on demand. Returning `silent` degrades to an explanation, not a broken player. */
  onRequest: () => Promise<PreviewResult>;
  /** Rendered next to the control — usually the text that will be spoken. */
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  size?: 'small' | 'middle' | 'large';
  block?: boolean;
  type?: 'default' | 'primary' | 'text' | 'link';
}

/**
 * Play button for a single TTS utterance.
 *
 * The important behaviour is the failure mode. On a dev box with no TTS
 * credential the control plane runs the mock provider, which produces silence.
 * A player that spins forever, or renders a scrubber over nothing, teaches the
 * operator to distrust the whole screen — so we say plainly that the preview is
 * unavailable and why.
 */
export function VoicePreviewPlayer({
  onRequest,
  label,
  disabled,
  disabledReason,
  size = 'small',
  block,
  type = 'default',
}: VoicePreviewPlayerProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current?.startsWith('blob:')) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const play = useCallback(async () => {
    if (state === 'playing') {
      cleanup();
      setState('idle');
      return;
    }
    setState('loading');
    setNote(null);
    try {
      const result = await onRequest();
      if (result.kind === 'silent') {
        setState('idle');
        setNote(result.reason);
        return;
      }
      cleanup();
      const audio = new Audio(result.url);
      audioRef.current = audio;
      urlRef.current = result.url;
      audio.onended = () => setState('idle');
      audio.onerror = () => {
        setState('idle');
        setNote('The audio stream could not be played.');
      };
      await audio.play();
      setState('playing');
    } catch (err) {
      setState('idle');
      setNote(err instanceof Error ? err.message : 'Preview failed.');
    }
  }, [cleanup, onRequest, state]);

  const icon =
    state === 'loading' ? (
      <LoadingOutlined />
    ) : state === 'playing' ? (
      <PauseOutlined />
    ) : (
      <PlayCircleOutlined />
    );

  const button = (
    <Button
      size={size}
      type={type}
      block={block}
      icon={icon}
      disabled={disabled || state === 'loading'}
      onClick={() => void play()}
    >
      {state === 'playing' ? 'Stop' : (label ?? 'Hear it')}
    </Button>
  );

  return (
    <Flex vertical gap={4} style={block ? { width: '100%' } : undefined}>
      {disabled && disabledReason ? <Tooltip title={disabledReason}>{button}</Tooltip> : button}
      {note && (
        <Flex align="flex-start" gap={6}>
          <SoundOutlined style={{ fontSize: 12, marginTop: 3, opacity: 0.6 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {note}
          </Typography.Text>
        </Flex>
      )}
    </Flex>
  );
}
