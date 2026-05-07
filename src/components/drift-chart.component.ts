import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriftPoint } from '../services/guider.store';

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

      <!-- Legend overlay -->
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
