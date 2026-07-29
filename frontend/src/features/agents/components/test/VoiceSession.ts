'use client';

/**
 * ============================================================================
 * THE TRANSPORT SEAM. Swapping in WebRTC means adding ONE file next to this one.
 * ============================================================================
 *
 * The test console is built entirely against this interface. Today the only
 * implementation is `SimulatedVoiceSession`, which replays a generated trace in
 * real time because **there is no live-audio backend yet** — the media node and
 * the WebRTC gateway of the design notes §3 are not running, and the control
 * plane exposes no session endpoint (its orchestrator simulator is in-process
 * only, with no route in front of it).
 *
 * That is stated in the UI on every screen that uses this, never hidden.
 *
 * To go live: implement `VoiceSession` over the gateway (offer/answer, one
 * DataChannel carrying the same `PipelineEvents` the trace recorder consumes),
 * export it, and switch `createVoiceSession`. No component changes — every
 * consumer already speaks this event shape, which is deliberately a subset of
 * `backend/control-plane/src/orchestration/events.ts`.
 */

import type { Track } from 'livekit-client';

import type { AgentModality, LatencyBreakdown, Turn } from '@/lib/contract';

/** Mirrors `CallState` in backend/control-plane/src/orchestration/state-machine.ts. */
export type CallState =
  | 'IDLE'
  | 'CONNECTING'
  | 'GREETING'
  | 'LISTENING'
  | 'SPECULATING'
  | 'THINKING'
  | 'TOOL_CALL'
  | 'FILLER'
  | 'SPEAKING'
  | 'BARGE_IN'
  | 'ENDED';

/** The states drawn as the machine's track, in the order a turn walks them. */
export const TURN_STATES: CallState[] = [
  'LISTENING',
  'SPECULATING',
  'THINKING',
  'TOOL_CALL',
  'SPEAKING',
];

export type VoiceSessionEvent =
  | { type: 'state'; state: CallState; trigger: string; tMs: number }
  | { type: 'partial'; role: 'caller' | 'agent'; text: string; turnIndex: number; tMs: number }
  | { type: 'final'; role: 'caller' | 'agent'; text: string; turnIndex: number; tMs: number }
  | { type: 'turn'; turn: Turn; latency: LatencyBreakdown; tMs: number }
  | { type: 'tool'; name: string; status: 'started' | 'ok' | 'timeout' | 'error'; durationMs?: number; tMs: number }
  | { type: 'filler'; text: string; tMs: number }
  | {
      type: 'bargein';
      turnIndex: number;
      heardChars: number;
      generatedChars: number;
      tMs: number;
    }
  | { type: 'error'; message: string }
  /**
   * The session's negotiated modality, emitted once the grant is known. Voice-only
   * transports (the simulator) never emit this; the console falls back to the
   * agent's own `modality` field in that case.
   */
  | { type: 'modality'; modality: AgentModality; tMs: number }
  /**
   * A camera track appeared or vanished. `track: null` means the track was
   * unpublished (local) or unsubscribed (remote). The UI attaches the LiveKit
   * `Track` to a `<video>` via `track.attach()` — the session never touches the DOM
   * for video, so a headless caller can still drive a call.
   */
  | { type: 'video'; source: 'local' | 'remote'; track: Track | null; tMs: number }
  | { type: 'ended'; reason: string; tMs: number };

export interface VoiceSessionOptions {
  agentId: string;
  /** The prompt currently in the editor — a live session would ship this as an override. */
  prompt?: string;
  /** Real microphone stream, when the user granted it. */
  micStream?: MediaStream | null;
  /** Playback rate for the simulator. 1 = real time. */
  speed?: number;
  seed?: number;
}

export interface VoiceSession {
  /** Rendered in the UI. Never let a simulated session look live. */
  readonly kind: 'simulated' | 'webrtc';
  readonly label: string;
  start(options: VoiceSessionOptions): Promise<void>;
  stop(reason?: string): Promise<void>;
  /** Interrupt the agent mid-utterance — the barge-in path. */
  interrupt(): void;
  subscribe(listener: (event: VoiceSessionEvent) => void): () => void;
  /** Available once the session ends: the full trace of what just happened. */
  getTrace(): import('@/lib/contract').CallTrace | null;
  /**
   * Video escalation — implemented only by the WebRTC transport. Absent on the
   * simulator, so the console feature-detects before offering an "escalate" control.
   * `startVideo` publishes the local camera; it rejects if the user denies the
   * camera so the caller can surface a permission error.
   */
  startVideo?(): Promise<void>;
  stopVideo?(): Promise<void>;
  /** True while the local camera is published. */
  readonly videoActive?: boolean;
  /** The negotiated modality once the session has started, else null. */
  readonly modality?: AgentModality | null;
}

/* The transport is chosen in `createVoiceSession.ts` — one import to change. */
