import { describe, expect, it } from 'vitest';

import {
  dictationMicrophoneEnergy,
  dictationSpectrumLevels,
  DictationWaveformNoiseGate,
} from './dictationWaveformMeter';

describe('dictation waveform metering', () => {
  it('removes the low analyser bins that represent the microphone noise floor', () => {
    const spectrum = new Uint8Array(32).fill(84);

    expect(dictationSpectrumLevels(spectrum, 4)).toEqual([0, 0, 0, 0]);
  });

  it('keeps speech and louder sounds responsive after the floor is removed', () => {
    const speech = dictationMicrophoneEnergy(
      dictationSpectrumLevels(new Uint8Array(32).fill(140)),
    );
    const loud = dictationMicrophoneEnergy(
      dictationSpectrumLevels(new Uint8Array(32).fill(210)),
    );

    expect(speech).toBeGreaterThan(0.35);
    expect(loud).toBeGreaterThan(speech);
    expect(loud).toBeLessThanOrEqual(1);
  });

  it('holds quiet ambient input at an exact zero', () => {
    const gate = new DictationWaveformNoiseGate();

    expect(Array.from({ length: 20 }, () => gate.sample(0.18))).toEqual(
      Array.from({ length: 20 }, () => 0),
    );
  });

  it('makes louder speech produce clearly taller first-response peaks', () => {
    const speechGate = new DictationWaveformNoiseGate();
    const loudGate = new DictationWaveformNoiseGate();
    const speech = speechGate.sample(0.5);
    const loud = loudGate.sample(0.8);

    expect(speech).toBeGreaterThan(0.5);
    expect(loud).toBeGreaterThan(0.8);
    expect(loud - speech).toBeGreaterThan(0.2);
  });

  it('uses hysteresis around speech and settles back to zero without chatter', () => {
    const gate = new DictationWaveformNoiseGate();
    const speech = gate.sample(0.5);
    const betweenThresholds = gate.sample(0.17);
    const tail = Array.from({ length: 20 }, () => gate.sample(0.04));

    expect(speech).toBeGreaterThan(0);
    expect(betweenThresholds).toBeGreaterThan(0);
    expect(tail.at(-1)).toBe(0);
    expect(tail.slice(-5)).toEqual([0, 0, 0, 0, 0]);
  });
});
