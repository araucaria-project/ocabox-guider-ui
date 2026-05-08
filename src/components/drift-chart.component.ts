import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriftPoint, InterventionMarker } from '../services/guider.store';

/**
 * Rolling drift-error chart. Two lines (image-X red, image-Y blue) on a
 * shared time axis. Y axis auto-scales but starts at ±5 px so a stable
 * acquired star has visible jitter rather than a flat line on top of
 * the axis.
 *
 * Axes are IMAGE pixel space, not astronomical — the mapping image →
 * RA/Dec is per-camera (transpose, mounting orientation) and lives in
 * the calibrated Jacobian. The chart deliberately stays neutral.
 *
 * In monitoring mode this is the un-corrected drift — the operator can
 * read tracking quality directly off the slope. In guiding mode it's
 * residual error after corrections, which should hover near zero.
 */
@Component({
  selector: 'app-drift-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="relative w-full">
      <svg
        [attr.viewBox]="'0 0 ' + W + ' ' + H"
        preserveAspectRatio="none"
        class="w-full h-36 block"
      >
        <!-- Background grid -->
        <rect x="0" y="0" [attr.width]="W" [attr.height]="H" fill="rgb(9, 9, 11)"/>
        @for (y of yTicks(); track y.v) {
          <line
            [attr.x1]="margin.left" [attr.x2]="W - margin.right"
            [attr.y1]="y.y" [attr.y2]="y.y"
            stroke="rgb(39, 39, 42)"
            stroke-width="1"
          />
        }
        <!-- Zero line -->
        <line
          [attr.x1]="margin.left" [attr.x2]="W - margin.right"
          [attr.y1]="zeroY()" [attr.y2]="zeroY()"
          stroke="rgb(82, 82, 91)"
          stroke-width="1"
        />

        <!-- Mode-transition vertical separators — emerald for
             monitoring → guiding, amber for the reverse. Drawn under
             the data lines so the trace is on top. -->
        @for (m of modeMarkers(); track m.t) {
          <line [attr.x1]="m.x" [attr.x2]="m.x"
                [attr.y1]="margin.top" [attr.y2]="H - margin.bottom"
                [attr.stroke]="m.color" stroke-width="1" stroke-dasharray="3 2"/>
          <text [attr.x]="m.x + 2" [attr.y]="margin.top + 9"
                font-size="9" font-family="ui-monospace, monospace"
                [attr.fill]="m.color">{{ m.label }}</text>
        }

        <!-- Pulse ticks — small vertical bars from the centre line,
             height proportional to total pulse magnitude. Auto = grey
             (so it doesn't fight the X/Y trace colours), manual =
             amber (operator-action emphasis). Low alpha keeps them
             unobtrusive — visible at a glance but the drift trace
             reads first. -->
        @for (p of pulseMarkers(); track p.t) {
          <line [attr.x1]="p.x" [attr.x2]="p.x"
                [attr.y1]="zeroY() - p.h" [attr.y2]="zeroY() + p.h"
                [attr.stroke]="p.color" stroke-width="1" [attr.stroke-opacity]="p.alpha"/>
        }

        @if (xPath(); as p) {
          <path [attr.d]="p" fill="none" stroke="rgb(244, 63, 94)" stroke-width="1.5"/>
        }
        @if (yPath(); as p) {
          <path [attr.d]="p" fill="none" stroke="rgb(56, 189, 248)" stroke-width="1.5"/>
        }

        <!-- Y axis labels (right-aligned in the left margin gutter) -->
        @for (y of yTicks(); track y.v) {
          <text
            [attr.x]="margin.left - 4" [attr.y]="y.y + 3"
            text-anchor="end"
            font-size="10"
            fill="rgb(113, 113, 122)"
            font-family="ui-monospace, monospace"
          >
            {{ y.v > 0 ? '+' : '' }}{{ y.v | number:'1.0-1' }}
          </text>
        }

        <!-- X axis: time markers (every minute, simple) -->
        @for (x of xTicks(); track x.t) {
          <line [attr.x1]="x.x" [attr.x2]="x.x" [attr.y1]="H - 12" [attr.y2]="H" stroke="rgb(63, 63, 70)" stroke-width="1"/>
          <text
            [attr.x]="x.x + 2" [attr.y]="H - 2"
            font-size="9"
            fill="rgb(113, 113, 122)"
            font-family="ui-monospace, monospace"
          >
            -{{ x.label }}
          </text>
        }
      </svg>

      <!-- Legend overlay — minimal: only the two trace colours. Pulse
           ticks + mode markers are described in the keyboard-help (?)
           dialog so the chart stays readable. -->
      <div class="absolute top-1 right-2 flex gap-3 text-[10px] font-mono pointer-events-none">
        <span class="text-rose-400">━ X dx</span>
        <span class="text-sky-400">━ Y dy</span>
        <span class="text-zinc-500">{{ points().length }} pts</span>
      </div>
    </div>
  `,
})
export class DriftChartComponent {
  /** Drift points for the active pipeline (rolling buffer from the store). */
  points = input.required<DriftPoint[]>();
  /** Intervention markers — mode flips and pulses, rendered as
   *  vertical annotations on the chart. Optional; default empty. */
  markers = input<InterventionMarker[]>([]);
  /** Window length in seconds; older samples are not drawn. */
  windowSeconds = input<number>(300);

  readonly W = 600;
  readonly H = 140;

  readonly margin = { top: 10, right: 8, bottom: 16, left: 38 };

  /** Auto-scale Y to data, but never tighter than ±5 px. */
  private yExtent = computed(() => {
    const pts = this.points();
    if (!pts.length) return 5;
    let m = 5;
    for (const p of pts) {
      const a = Math.abs(p.dx);
      const b = Math.abs(p.dy);
      if (a > m) m = a;
      if (b > m) m = b;
    }
    // round up to a tidy bound
    return Math.ceil(m * 1.15);
  });

  zeroY = computed(() => this.margin.top + (this.H - this.margin.top - this.margin.bottom) / 2);

  yTicks = computed(() => {
    const e = this.yExtent();
    const yMid = this.zeroY();
    const half = (this.H - this.margin.top - this.margin.bottom) / 2;
    const out: { v: number; y: number }[] = [];
    for (const v of [-e, -e / 2, 0, e / 2, e]) {
      out.push({ v, y: yMid - (v / e) * half });
    }
    return out;
  });

  xTicks = computed(() => {
    const w = this.windowSeconds();
    const out: { t: number; x: number; label: string }[] = [];
    const usable = this.W - this.margin.left - this.margin.right;
    for (let s = 60; s <= w; s += 60) {
      out.push({
        t: s,
        x: this.margin.left + usable * (1 - s / w),
        label: `${Math.round(s / 60)}m`,
      });
    }
    return out;
  });

  xPath = computed(() => this.buildPath('dx'));
  yPath = computed(() => this.buildPath('dy'));

  /** Mode-change marker positions. Newest entries to the right —
   *  same mapping as ``buildPath`` so they line up with the trace. */
  modeMarkers = computed(() => {
    const now = Date.now();
    const win = this.windowSeconds() * 1000;
    const usableW = this.W - this.margin.left - this.margin.right;
    const out: { t: number; x: number; color: string; label: string }[] = [];
    for (const m of this.markers()) {
      if (m.kind !== 'mode' || !m.mode) continue;
      const ageMs = now - m.t;
      if (ageMs > win || ageMs < 0) continue;
      const x = this.margin.left + usableW * (1 - ageMs / win);
      const isGuidingOn = m.mode.to === 'guiding';
      out.push({
        t: m.t, x,
        color: isGuidingOn ? 'rgb(52, 211, 153)' : 'rgb(251, 191, 36)',
        label: m.mode.to.slice(0, 3),
      });
    }
    return out;
  });

  /** Pulse marker positions + visual heights. Magnitude → bar half-height
   *  scaled relative to maximum recent pulse so the chart shows
   *  *relative* intensity (saturated 1500ms-cap pulses don't dwarf
   *  small corrections; both fit within the chart vertically). */
  pulseMarkers = computed(() => {
    const now = Date.now();
    const win = this.windowSeconds() * 1000;
    const usableW = this.W - this.margin.left - this.margin.right;
    const halfH = (this.H - this.margin.top - this.margin.bottom) / 2;
    // Scale: pulses range 0–1500ms typically; map to 0.2..0.95 of half-height
    // so even tiny corrections produce a visible tick.
    const pulses = this.markers().filter(m => m.kind === 'pulse' && m.pulse);
    const maxMs = pulses.reduce((a, m) => Math.max(a, m.pulse?.total_ms ?? 0), 0) || 100;
    const out: { t: number; x: number; h: number; color: string; alpha: number }[] = [];
    for (const m of pulses) {
      const ageMs = now - m.t;
      if (ageMs > win || ageMs < 0) continue;
      const x = this.margin.left + usableW * (1 - ageMs / win);
      const ms = m.pulse!.total_ms;
      const h = halfH * (0.2 + 0.75 * Math.min(1, ms / maxMs));
      // Auto pulses are common (every 1-2s during active guiding) so
      // they need to fade into the background — operator wants to see
      // the drift trace first, ticks as cadence indicator. Manual
      // commands are rare events and stay sharper.
      const auto = m.pulse!.source === 'auto';
      const color = auto
        ? 'rgb(161, 161, 170)'  // zinc-400 (neutral grey)
        : 'rgb(251, 191, 36)';  // amber-400 (operator action)
      const alpha = auto ? 0.55 : 0.8;
      out.push({ t: m.t, x, h, color, alpha });
    }
    return out;
  });

  private buildPath(axis: 'dx' | 'dy'): string | null {
    const pts = this.points();
    if (pts.length < 2) return null;
    const now = Date.now();
    const win = this.windowSeconds() * 1000;
    const e = this.yExtent();
    const usableW = this.W - this.margin.left - this.margin.right;
    const usableH = (this.H - this.margin.top - this.margin.bottom) / 2;
    const yMid = this.zeroY();
    let d = '';
    let started = false;
    for (const p of pts) {
      const ageMs = now - p.t;
      if (ageMs > win) continue;
      const x = this.margin.left + usableW * (1 - ageMs / win);
      const y = yMid - (p[axis] / e) * usableH;
      d += (started ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
      started = true;
    }
    return started ? d : null;
  }
}
