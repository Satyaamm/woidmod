/**
 * PCM → WAV.
 *
 * Every TTS adapter normalises its vendor's output to the same thing: mono PCM at
 * a declared sample rate, as float samples in [-1, 1] (`AudioChunk`). That is what
 * the call pipeline wants and what a browser cannot play — an `<audio>` element
 * needs a container. Forty-four bytes of RIFF header is the entire difference, so
 * voice preview does not need an encoder, a worker, or object storage to exist.
 *
 * Deliberately WAV rather than MP3/Opus: no dependency, no licensing, and the clip
 * is a two-second phrase where the size difference does not matter.
 */

import type { AudioChunk } from '../providers/types.js';

/** 16-bit PCM — universally playable, and what the float samples came from. */
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

function toInt16(chunk: AudioChunk): Int16Array {
  if (chunk.data instanceof Float32Array) {
    const out = new Int16Array(chunk.data.length);
    for (let i = 0; i < chunk.data.length; i += 1) {
      // Clamp before scaling: a sample above 1.0 wraps to a loud click otherwise.
      const s = Math.max(-1, Math.min(1, chunk.data[i] ?? 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  // A pass-through adapter that already emitted 16-bit frames. An odd trailing
  // byte is a truncated sample, not a sample — drop it rather than shift the rest.
  const bytes = chunk.data;
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable));
}

/**
 * Assemble streamed chunks into one WAV file.
 *
 * The sample rate comes from the chunks themselves — adapters run at 16k, 22.05k
 * or 24k depending on the vendor, and playing 24k audio as 16k is the chipmunk bug
 * that makes a preview useless for judging a voice.
 */
export function chunksToWav(chunks: readonly AudioChunk[]): { bytes: Uint8Array; sampleRate: number } {
  const sampleRate = chunks[0]?.sampleRate ?? 24_000;
  const samples = chunks.map(toInt16);
  const total = samples.reduce((n, s) => n + s.length, 0);

  const dataBytes = total * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8;
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size minus the 8-byte RIFF header
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of samples) {
    for (let i = 0; i < chunk.length; i += 1, offset += 2) view.setInt16(offset, chunk[i] ?? 0, true);
  }

  return { bytes: new Uint8Array(buffer), sampleRate };
}

/**
 * A `data:` URL an `<audio>` element can play directly.
 *
 * Inline rather than uploaded: a preview is listened to once and discarded, and
 * making it depend on object storage would mean no customer could hear a voice
 * until S3 was configured — for audio measured in tens of kilobytes.
 */
export function wavDataUrl(chunks: readonly AudioChunk[]): string {
  const { bytes } = chunksToWav(chunks);
  return `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`;
}
