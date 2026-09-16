import { useEffect, useRef, useState } from 'react';

import {
  dictationWaveformLabel,
  useDictationWaveformStyle,
  type DictationWaveformStyle,
} from '../../lib/dictationWaveform';
import {
  dictationMicrophoneEnergy,
  DictationWaveformNoiseGate,
} from '../../lib/dictationWaveformMeter';
import { micDictation } from '../../lib/stt';

const BAR_COUNT = 28;
const RESTING_LEVELS = Array.from({ length: BAR_COUNT }, () => 0);
const TIMELINE_SAMPLES = 88;
const TIMELINE_INTERVAL_MS = 80;
const RESTING_TIMELINE = Array.from({ length: TIMELINE_SAMPLES }, () => 0);
const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 40;
const CENTERLINE = VIEW_HEIGHT / 2;
const FILAMENT_TIP_X = VIEW_WIDTH - 7.5;
const FILAMENT_STROKE = 'url(#vp-waveform-filament-gradient)';
const FILAMENT_LIGHT_COLOR = 'color-mix(in srgb, var(--brand) 38%, white)';
const FILAMENT_TIP_COLOR = 'color-mix(in srgb, var(--brand) 62%, black)';

type Point = readonly [x: number, y: number];

/** Compact, microphone-driven level meter shown immediately above the composer. */
export function DictationWaveform() {
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const levelsRef = useRef<readonly number[]>(RESTING_LEVELS);
  const noiseGateRef = useRef(new DictationWaveformNoiseGate());
  const sampleIndexRef = useRef(0);
  const [timeline, setTimeline] = useState<readonly number[]>(RESTING_TIMELINE);
  const [sampleCount, setSampleCount] = useState(0);
  const style = useDictationWaveformStyle();

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const onChange = () => setReduceMotion(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    return micDictation.subscribeLevels((next) => {
      levelsRef.current = next;
    });
  }, [reduceMotion]);

  // One bounded time history drives both candidates. The sign is captured with
  // each sample so the filament's contour moves left intact, while Voice Memos
  // uses its magnitude. Changing styles never touches the mic.
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      const energy = noiseGateRef.current.sample(dictationMicrophoneEnergy(levelsRef.current));
      const index = ++sampleIndexRef.current;
      const direction = (Math.sin(index * 1.37) + Math.sin(index * 0.53) * 0.3) / 1.3;
      setTimeline((previous) => [...previous.slice(1), energy * direction]);
      setSampleCount((count) => Math.min(count + 1, TIMELINE_SAMPLES));
    }, TIMELINE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Listening for dictation · ${dictationWaveformLabel(style)} waveform`}
      className="relative left-1/2 mb-2 flex h-[5.5rem] w-[100dvw] -translate-x-1/2 items-center justify-center overflow-hidden md:static md:h-28 md:w-full md:translate-x-0"
    >
      <div className="flex w-full items-center gap-2 pr-[15px]">
        <WaveformGraphic
          timeline={timeline}
          style={style}
          revealCount={reduceMotion ? TIMELINE_SAMPLES : sampleCount}
        />
      </div>
    </div>
  );
}

function WaveformGraphic({
  timeline,
  style,
  revealCount,
}: {
  timeline: readonly number[];
  style: DictationWaveformStyle;
  revealCount: number;
}) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className={`h-10 shrink-0 overflow-hidden ${
        style === 10
          ? 'w-full md:[-webkit-mask-image:linear-gradient(to_right,transparent,black_8%)] md:[mask-image:linear-gradient(to_right,transparent,black_8%)]'
          : 'w-full md:[-webkit-mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] md:[mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]'
      }`}
      aria-hidden
      preserveAspectRatio="none"
    >
      {style === 10 ? <GoldenFilament timeline={timeline} revealCount={revealCount} /> : null}
      {style === 16 ? <VoiceMemosTimeline timeline={timeline} /> : null}
    </svg>
  );
}

// The filament is the recording's history, so it appears with elapsed time:
// only the newest `revealCount` samples are drawn, extending the line out of
// the tip dot one slot per timeline tick until the full history is visible.
function GoldenFilament({ timeline, revealCount }: { timeline: readonly number[]; revealCount: number }) {
  const points = timelinePoints(smoothFilamentTimeline(timeline), 18, FILAMENT_TIP_X);
  const visible = revealCount >= 2 ? points.slice(points.length - Math.min(revealCount, points.length)) : [];
  const tip = points.at(-1) ?? [FILAMENT_TIP_X, CENTERLINE];
  return (
    <>
      <defs>
        <linearGradient
          id="vp-waveform-filament-gradient"
          gradientUnits="userSpaceOnUse"
          x1="0"
          x2={FILAMENT_TIP_X}
        >
          <stop offset="0%" stopColor={FILAMENT_LIGHT_COLOR} stopOpacity="0" />
          <stop offset="20%" stopColor={FILAMENT_LIGHT_COLOR} />
          <stop offset="68%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor={FILAMENT_TIP_COLOR} />
        </linearGradient>
        <filter id="vp-waveform-glow" x="-20%" y="-80%" width="140%" height="260%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>
      <path
        d={taperedFilamentPath(visible, 7)}
        fill={FILAMENT_STROKE}
        opacity="0.13"
        filter="url(#vp-waveform-glow)"
      />
      <path
        d={taperedFilamentPath(visible, 3)}
        fill={FILAMENT_STROKE}
        opacity="0.2"
      />
      <path
        d={taperedFilamentPath(visible, 1.1)}
        fill={FILAMENT_STROKE}
      />
      <g
        className="transition-transform duration-150 ease-out motion-reduce:transition-none"
        style={{ transform: `translateY(${tip[1] - CENTERLINE}px)` }}
      >
        <line
          x1={tip[0]}
          x2={tip[0]}
          y1={CENTERLINE}
          y2={CENTERLINE}
          stroke={FILAMENT_TIP_COLOR}
          strokeWidth="7"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          opacity="0.42"
          className="vp-filament-tip-ping"
        />
        <line
          x1={tip[0]}
          x2={tip[0]}
          y1={CENTERLINE}
          y2={CENTERLINE}
          stroke={FILAMENT_TIP_COLOR}
          strokeWidth="3.4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </>
  );
}

function VoiceMemosTimeline({ timeline }: { timeline: readonly number[] }) {
  return (
    <>
      {timeline.map((sample, index) => {
        const x = (index / (timeline.length - 1)) * VIEW_WIDTH;
        const halfHeight = 1 + Math.abs(sample) * 18;
        return (
          <line
            key={index}
            x1={x}
            x2={x}
            y1={CENTERLINE - halfHeight}
            y2={CENTERLINE + halfHeight}
            stroke="var(--destructive)"
            strokeWidth="1.15"
            strokeLinecap="round"
            className="md:[vector-effect:non-scaling-stroke]"
          />
        );
      })}
    </>
  );
}

function timelinePoints(timeline: readonly number[], height: number, width = VIEW_WIDTH): Point[] {
  return timeline.map<Point>((sample, index) => [
    (index / (timeline.length - 1)) * width,
    CENTERLINE + sample * height,
  ]);
}

function smoothFilamentTimeline(timeline: readonly number[]): number[] {
  return timeline.map((sample, index) => {
    const previous = timeline[index - 1] ?? sample;
    const earlier = timeline[index - 2] ?? previous;
    return sample * 0.5 + previous * 0.32 + earlier * 0.18;
  });
}

function taperedFilamentPath(points: readonly Point[], maximumWidth: number): string {
  if (points.length === 0) return '';
  const upper = points.map<Point>(([x, y], index) => {
    const width = maximumWidth * (index / Math.max(points.length - 1, 1));
    return [x, y - width / 2];
  });
  const lower = points.map<Point>(([x, y], index) => {
    const width = maximumWidth * (index / Math.max(points.length - 1, 1));
    return [x, y + width / 2];
  });
  return `${smoothPath([...upper, ...lower.reverse()])} Z`;
}

function smoothPath(points: readonly Point[]): string {
  const first = points[0];
  if (!first) return '';
  if (points.length === 1) return `M ${first[0]} ${first[1]}`;
  let path = `M ${first[0]} ${first[1]}`;
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${point[0]} ${point[1]} ${(point[0] + next[0]) / 2} ${(point[1] + next[1]) / 2}`;
  }
  const beforeLast = points.at(-2)!;
  const last = points.at(-1)!;
  return `${path} Q ${beforeLast[0]} ${beforeLast[1]} ${last[0]} ${last[1]}`;
}
