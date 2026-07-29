'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Browser microphone: permission, stream, and a live input level.
 *
 * The mic is REAL even though the session is simulated — the level meter is
 * driven by actual audio frames. That is deliberate: permission handling, device
 * loss and "your mic is muted at the OS level" are the failures that break a
 * first test call, and they must be shaken out before the transport lands. The
 * UI is explicit that the captured audio goes nowhere yet.
 */

export type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';

export interface Microphone {
  permission: MicPermission;
  stream: MediaStream | null;
  /** 0..1, smoothed RMS of the last analysis frame. */
  level: number;
  deviceLabel: string | null;
  error: string | null;
  request: () => Promise<MediaStream | null>;
  release: () => void;
}

export function useMicrophone(): Microphone {
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);

  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPermission('unsupported');
      return;
    }
    // Permissions API is not universal; a miss just means "we'll find out on click".
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        setPermission(status.state as MicPermission);
        status.onchange = () => setPermission(status.state as MicPermission);
      })
      .catch(() => setPermission('prompt'));
  }, []);

  const request = useCallback(async () => {
    setError(null);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setStream(next);
      setPermission('granted');
      setDeviceLabel(next.getAudioTracks()[0]?.label ?? 'Default input');

      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(next).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);

      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 1) sum += buffer[i]! * buffer[i]!;
        const rms = Math.sqrt(sum / buffer.length);
        // Smoothed, and scaled so speech lands in the upper half of the meter.
        setLevel((prev) => prev * 0.6 + Math.min(1, rms * 4) * 0.4);
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
      return next;
    } catch (err) {
      const message = (err as Error).name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in the browser address bar, then try again.'
        : (err as Error).message;
      setError(message);
      setPermission('denied');
      return null;
    }
  }, []);

  const release = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
    void audioCtx.current?.close();
    audioCtx.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setLevel(0);
  }, [stream]);

  useEffect(() => () => release(), [release]);

  return { permission, stream, level, deviceLabel, error, request, release };
}
