const SPECTRUM_NOISE_FLOOR = 84;
const SPECTRUM_RANGE = 255 - SPECTRUM_NOISE_FLOOR;
const SPECTRUM_CURVE = 1.15;
const VOICE_BIN_COUNT = 20;
const ENERGY_GAIN = 1.65;

const GATE_OPEN_THRESHOLD = 0.2;
const GATE_CLOSE_THRESHOLD = 0.13;
const GATE_HOLD_SAMPLES = 2;
const PEAK_GAIN = 1.25;
const ATTACK = 0.84;
const RELEASE = 0.38;
const OUTPUT_CURVE = 0.72;
const ZERO_SNAP = 0.015;

/**
 * Convert analyser FFT bytes into display-only waveform levels. The analyser's
 * byte scale is logarithmic, so cutting its lowest ~23 dB before applying the
 * curve removes microphone self-noise without touching the captured audio.
 */
export function dictationSpectrumLevels(
  spectrum: ArrayLike<number>,
  levelCount = 28,
): number[] {
  return Array.from({ length: levelCount }, (_, index) => {
    const bin = Number(spectrum[index + 1] ?? 0);
    const value = Math.max(0, (bin - SPECTRUM_NOISE_FLOOR) / SPECTRUM_RANGE);
    return Math.min(1, Math.pow(value, SPECTRUM_CURVE));
  });
}

/** Collapse the speech-frequency bins into one stable waveform envelope. */
export function dictationMicrophoneEnergy(levels: readonly number[]): number {
  const voiceBins = levels.slice(0, VOICE_BIN_COUNT);
  if (voiceBins.length === 0) return 0;
  const sumSquares = voiceBins.reduce((sum, level) => sum + level * level, 0);
  return Math.min(1, Math.sqrt(sumSquares / voiceBins.length) * ENERGY_GAIN);
}

/**
 * A small display-only noise gate. Separate open/close thresholds prevent
 * chatter around the floor; a short hold and envelope smoothing preserve
 * natural syllable shapes while still allowing silence to become exactly zero.
 */
export class DictationWaveformNoiseGate {
  private open = false;
  private quietSamples = 0;
  private output = 0;

  sample(energy: number): number {
    const input = Math.min(1, Math.max(0, energy));

    if (this.open) {
      if (input < GATE_CLOSE_THRESHOLD) {
        this.quietSamples++;
        if (this.quietSamples > GATE_HOLD_SAMPLES) this.open = false;
      } else {
        this.quietSamples = 0;
      }
    } else if (input >= GATE_OPEN_THRESHOLD) {
      this.open = true;
      this.quietSamples = 0;
    }

    const gated = this.open
      ? Math.min(
          1,
          Math.pow(
            Math.max(0, (input - GATE_CLOSE_THRESHOLD) / (1 - GATE_CLOSE_THRESHOLD)),
            OUTPUT_CURVE,
          ) * PEAK_GAIN,
        )
      : 0;
    const smoothing = gated > this.output ? ATTACK : RELEASE;
    this.output += (gated - this.output) * smoothing;

    if (!this.open && this.output < ZERO_SNAP) this.output = 0;
    return this.output;
  }
}
