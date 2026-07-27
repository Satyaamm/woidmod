'use client';

/**
 * The one place a transport is chosen.
 *
 * Real WebRTC when the platform can serve it, the simulator when it can't. The
 * check is a real capability probe against `GET /v1/voice/status`, not a build
 * flag — a developer without LiveKit running still gets a working console, and
 * nobody ever sees a simulated session labelled as live.
 */

import { http } from '@/lib/api';
import { SimulatedVoiceSession } from './SimulatedVoiceSession';
import { WebRtcVoiceSession } from './WebRtcVoiceSession';
import type { VoiceSession } from './VoiceSession';

export interface VoiceCapability {
  available: boolean;
  /** Why live calling is unavailable — shown verbatim in the UI, never paraphrased. */
  reason: string | null;
}

export async function checkVoiceCapability(): Promise<VoiceCapability> {
  try {
    const res = await http.get<VoiceCapability>('/voice/status');
    return res.data;
  } catch {
    return {
      available: false,
      reason: 'Cannot reach the control plane. Is it running on port 3101?',
    };
  }
}

export function createVoiceSession(live: boolean): VoiceSession {
  return live ? new WebRtcVoiceSession() : new SimulatedVoiceSession();
}
