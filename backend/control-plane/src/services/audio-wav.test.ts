/**
 * WAV assembly.
 *
 * A wrong header does not error — it plays. Wrong sample rate is a chipmunk, wrong
 * data length is a clip that stops early, wrong clamping is a click. All of those
 * would be blamed on the TTS vendor by whoever heard them, so they are asserted at
 * the byte level here.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { chunksToWav, wavDataUrl } from './audio-wav.js';
import type { AudioChunk } from '../providers/types.js';

const chunk = (data: Float32Array | Uint8Array, sampleRate = 24_000, sequence = 0): AudioChunk => ({
  data,
  sampleRate,
  sequence,
});

describe('chunksToWav', () => {
  test('writes a RIFF/WAVE header whose lengths match the payload', () => {
    const { bytes } = chunksToWav([chunk(new Float32Array([0, 0.5, -0.5, 1]))]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (o: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));

    assert.equal(ascii(0, 4), 'RIFF');
    assert.equal(ascii(8, 4), 'WAVE');
    assert.equal(ascii(12, 4), 'fmt ');
    assert.equal(ascii(36, 4), 'data');
    assert.equal(view.getUint16(20, true), 1, 'format must be PCM');
    assert.equal(view.getUint16(22, true), 1, 'mono');
    assert.equal(view.getUint16(34, true), 16, '16-bit samples');

    const dataBytes = 4 * 2;
    assert.equal(view.getUint32(40, true), dataBytes);
    assert.equal(view.getUint32(4, true), 36 + dataBytes);
    assert.equal(bytes.byteLength, 44 + dataBytes);
  });

  test("the vendor's sample rate is carried through, not assumed", () => {
    const { bytes, sampleRate } = chunksToWav([chunk(new Float32Array([0, 0]), 16_000)]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(sampleRate, 16_000);
    assert.equal(view.getUint32(24, true), 16_000);
    // byte rate = rate * channels * bytes-per-sample
    assert.equal(view.getUint32(28, true), 32_000);
  });

  test('samples beyond full scale clamp instead of wrapping to a click', () => {
    const { bytes } = chunksToWav([chunk(new Float32Array([2, -2]))]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(view.getInt16(44, true), 32_767);
    assert.equal(view.getInt16(46, true), -32_768);
  });

  test('chunks are concatenated in the order streamed', () => {
    const { bytes } = chunksToWav([
      chunk(new Float32Array([1])),
      chunk(new Float32Array([-1]), 24_000, 1),
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(view.getUint32(40, true), 4);
    assert.equal(view.getInt16(44, true), 32_767);
    assert.equal(view.getInt16(46, true), -32_768);
  });

  test('an odd trailing byte from a pass-through adapter is dropped, not shifted in', () => {
    const { bytes } = chunksToWav([chunk(new Uint8Array([0x00, 0x40, 0x7f]))]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(view.getUint32(40, true), 2, 'one whole sample survives');
  });

  test('no chunks yields a valid, empty file rather than a malformed one', () => {
    const { bytes } = chunksToWav([]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(bytes.byteLength, 44);
    assert.equal(view.getUint32(40, true), 0);
  });
});

describe('wavDataUrl', () => {
  test('is a playable audio/wav data URL', () => {
    const url = wavDataUrl([chunk(new Float32Array([0, 0.25]))]);
    assert.match(url, /^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(url.split(',')[1] ?? '', 'base64').subarray(0, 4).toString(), 'RIFF');
  });
});
