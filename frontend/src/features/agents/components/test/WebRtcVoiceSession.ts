'use client';

/**
 * Real WebRTC session against the LiveKit room our agent worker joins.
 *
 * Flow:
 *   1. `POST /v1/agents/:id/sessions` mints a room + token with an embedded agent
 *      dispatch, so the worker joins the moment the room exists — the caller never
 *      sits in an empty room.
 *   2. Browser connects, publishes the microphone, subscribes to the agent's audio.
 *   3. Pipeline events arrive over LiveKit's data channel using the same shapes the
 *      trace viewer already renders, so nothing downstream changes between a
 *      simulated and a real call.
 *
 * The mic is genuinely captured and genuinely transmitted here — unlike the
 * simulator, which captured audio and sent it nowhere. `kind: 'webrtc'` is what the
 * UI keys off to stop labelling the session as simulated.
 */

import {
  createLocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteVideoTrack,
} from 'livekit-client';

import { http } from '@/lib/api';
import type { AgentModality, CallTrace, LatencyBreakdown, Turn } from '@/lib/contract';
import type {
  CallState,
  VoiceSession,
  VoiceSessionEvent,
  VoiceSessionOptions,
} from './VoiceSession';

interface SessionGrant {
  callId: string;
  url: string;
  token: string;
  /** Voice-only, video-capable, or both. Gates whether the camera is published. */
  modality: AgentModality;
  agent: { id: string; name: string; version: number; language: string };
}

/** Pipeline event names → the console's state machine. Mirrors events.ts. */
const STATE_FOR_EVENT: Record<string, CallState> = {
  'call.started': 'GREETING',
  'vad.speech_start': 'LISTENING',
  'endpoint.speculate': 'SPECULATING',
  'endpoint.commit': 'THINKING',
  'llm.first_token': 'THINKING',
  'tool.started': 'TOOL_CALL',
  'filler.played': 'FILLER',
  'tts.first_audio': 'SPEAKING',
  'bargein.detected': 'BARGE_IN',
  'call.ended': 'ENDED',
};

export class WebRtcVoiceSession implements VoiceSession {
  readonly kind = 'webrtc' as const;
  readonly label = 'Live call';

  private room: Room | null = null;
  private listeners = new Set<(e: VoiceSessionEvent) => void>();
  private startedAt = 0;
  private events: Array<Record<string, unknown>> = [];
  private turns: Turn[] = [];
  private grant: SessionGrant | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private localVideo: LocalVideoTrack | null = null;

  async start(options: VoiceSessionOptions): Promise<void> {
    this.startedAt = performance.now();
    this.events = [];
    this.turns = [];

    this.emit({ type: 'state', state: 'CONNECTING', trigger: 'session.start', tMs: 0 });

    const res = await http.post<SessionGrant>(`/agents/${options.agentId}/sessions`, {
      mode: 'test',
    });
    this.grant = res.data;
    this.emit({ type: 'modality', modality: res.data.modality, tMs: this.now() });

    const room = new Room({
      // Echo cancellation is not optional on a speakerphone: without it the agent
      // hears its own output and barge-in fires on every word it speaks.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      // The turn detector wants speech promptly; adaptive stream would trade
      // latency for bandwidth we don't need on a single audio track.
      adaptiveStream: false,
      dynacast: false,
    });
    this.room = room;

    room.on(RoomEvent.DataReceived, (payload) => this.onData(payload));
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) this.attachAgentAudio(track as RemoteAudioTrack);
      // The avatar video: the session doesn't render it, it hands the track to the
      // UI, which attaches it to the agent tile. Absent until a video agent joins.
      if (track.kind === Track.Kind.Video) {
        this.emit({ type: 'video', source: 'remote', track: track as RemoteVideoTrack, tMs: this.now() });
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video) {
        this.emit({ type: 'video', source: 'remote', track: null, tMs: this.now() });
      }
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      this.emit({ type: 'ended', reason: String(reason ?? 'disconnected'), tMs: this.now() });
    });
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      // The agent worker joining is the signal the call is actually live.
      if (p.identity.startsWith('agent') || p.identity.includes('woidmod')) {
        this.emit({ type: 'state', state: 'GREETING', trigger: 'agent.joined', tMs: this.now() });
      }
    });

    await room.connect(this.grant.url, this.grant.token);
    await room.localParticipant.setMicrophoneEnabled(true);

    // A video-only agent is face-to-face by definition — publish the camera up
    // front. `both` stays voice-first: the caller escalates when they choose to.
    if (this.grant.modality === 'video') {
      try {
        await this.startVideo();
      } catch (err) {
        // A denied camera must not kill an otherwise-working audio call.
        this.emit({ type: 'error', message: (err as Error).message });
      }
    }
  }

  /** True while the local camera is published. */
  get videoActive(): boolean {
    return this.localVideo != null;
  }

  /** The negotiated modality once the grant is known, else null. */
  get modality(): AgentModality | null {
    return this.grant?.modality ?? null;
  }

  /**
   * Escalate to video: capture the camera, publish it alongside the mic, and hand
   * the track to the UI for the self-view. Rejects if the camera is unavailable or
   * the user denies it, so the caller can surface the permission error.
   */
  async startVideo(): Promise<void> {
    if (!this.room || this.localVideo) return;
    let track: LocalVideoTrack;
    try {
      track = await createLocalVideoTrack({ facingMode: 'user' });
    } catch (err) {
      const name = (err as Error).name;
      throw new Error(
        name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in the browser address bar, then escalate again.'
          : name === 'NotFoundError'
            ? 'No camera found. Connect one and try escalating again.'
            : `Could not start the camera (${name || 'unknown error'}).`,
      );
    }
    this.localVideo = track;
    await this.room.localParticipant.publishTrack(track);
    this.emit({ type: 'video', source: 'local', track, tMs: this.now() });
  }

  /** Drop back to audio: unpublish and stop the camera. */
  async stopVideo(): Promise<void> {
    const track = this.localVideo;
    if (!track) return;
    this.localVideo = null;
    await this.room?.localParticipant.unpublishTrack(track, true);
    track.stop();
    this.emit({ type: 'video', source: 'local', track: null, tMs: this.now() });
  }

  private attachAgentAudio(track: RemoteAudioTrack): void {
    // Browsers block autoplay until a user gesture. The console only ever starts a
    // session from a click, so by here we have one — but if playback still fails we
    // surface it rather than leaving the user with a silent, apparently-broken call.
    const el = track.attach() as HTMLAudioElement;
    el.autoplay = true;
    document.body.appendChild(el);
    this.audioEl = el;
    void el.play().catch((err) => {
      this.emit({
        type: 'error',
        message: `Browser blocked audio playback (${err.name}). Click anywhere and retry.`,
      });
    });
  }

  /** Pipeline events from the worker, in the same shape the trace viewer consumes. */
  private onData(payload: Uint8Array): void {
    let batch: Array<Record<string, unknown>>;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(payload));
      batch = Array.isArray(decoded?.events) ? decoded.events : [decoded];
    } catch {
      return; // not ours; another data publisher on the room
    }

    for (const event of batch) {
      this.events.push(event);
      const type = String(event.type ?? '');
      const tMs = Number(event.tMs ?? this.now());

      const state = STATE_FOR_EVENT[type];
      if (state) this.emit({ type: 'state', state, trigger: type, tMs });

      if (type === 'stt.partial' || type === 'stt.final') {
        this.emit({
          type: type === 'stt.final' ? 'final' : 'partial',
          role: 'caller',
          text: String(event.text ?? ''),
          turnIndex: Number(event.turnIndex ?? this.turns.length),
          tMs,
        });
      }

      if (type === 'llm.text') {
        this.emit({
          type: 'final',
          role: 'agent',
          text: String(event.text ?? ''),
          turnIndex: Number(event.turnIndex ?? this.turns.length),
          tMs,
        });
      }

      if (type === 'filler.played') {
        this.emit({ type: 'filler', text: String(event.text ?? ''), tMs });
      }

      if (type === 'tool.started' || type === 'tool.finished') {
        this.emit({
          type: 'tool',
          name: String(event.name ?? 'tool'),
          status: type === 'tool.started' ? 'started' : (event.status as 'ok') ?? 'ok',
          durationMs: event.durationMs as number | undefined,
          tMs,
        });
      }

      if (type === 'bargein.truncated') {
        this.emit({
          type: 'bargein',
          turnIndex: Number(event.turnIndex ?? this.turns.length),
          heardChars: Number(event.playedOutChars ?? 0),
          generatedChars: Number(event.generatedChars ?? 0),
          tMs,
        });
      }

      if (type === 'turn.completed') {
        const latency = event as unknown as LatencyBreakdown;
        const turn: Turn = {
          index: Number(event.turnIndex ?? this.turns.length),
          role: 'agent',
          transcript: '',
          startMs: tMs - Number(event.totalMs ?? 0),
          endMs: tMs,
          latency,
        };
        this.turns.push(turn);
        this.emit({ type: 'turn', turn, latency, tMs });
      }
    }
  }

  /**
   * Barge-in from the UI button.
   *
   * Note this is a *convenience*, not the real path — a real interruption is the
   * user simply talking over the agent, which the worker detects from audio. This
   * exists so the behaviour is demonstrable without needing to speak.
   */
  interrupt(): void {
    void this.room?.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: 'client.interrupt' })),
      { reliable: true },
    );
  }

  async stop(reason = 'user_ended'): Promise<void> {
    this.audioEl?.remove();
    this.audioEl = null;
    if (this.localVideo) {
      this.localVideo.stop();
      this.localVideo = null;
    }
    await this.room?.disconnect();
    this.room = null;
    this.emit({ type: 'ended', reason, tMs: this.now() });
  }

  subscribe(listener: (e: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The trace is authored by the backend, not reconstructed here — this returns
   * null so the console links to the real `/calls/:id` trace instead of showing a
   * client-side approximation of one.
   */
  getTrace(): CallTrace | null {
    return null;
  }

  get callId(): string | null {
    return this.grant?.callId ?? null;
  }

  private now(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  private emit(event: VoiceSessionEvent): void {
    for (const l of this.listeners) l(event);
  }
}
