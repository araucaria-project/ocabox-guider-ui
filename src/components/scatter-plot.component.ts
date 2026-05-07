import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriftPoint } from '../services/guider.store';

/**
 * Scatter plot of recent drift error points in IMAGE pixel space.
 *
 * Axes match the preview frame: X horizontal, Y vertical going DOWN
 * (image convention, not astronomical). A drift the operator sees in
 * the live image will appear in the same direction on this chart.
 *
 * Mapping image-X / Y → RA / Dec is per-camera (depends on optics +
 * any ``protocol.transpose`` flag) and lives in the calibrated Jacobian
 * — we deliberately don't expose it here, because labelling axes "RA"
 * and "Dec" was wrong for cameras with a transpose (e.g. BESO, where
 * the calibrated mapping is N→image-X / E→image-Y, the opposite of the
 * naive guess).
 *
 * The drift chart shows error *over time* — useful for trends. The
 * scatter complements it by showing *distribution*: a tight cluster
 * around the origin = good guiding; a smear in one axis = mount drift
 * in that axis; a streak = systematic error / periodic error.
 *
 * Older points fade so the eye anchors on recent samples.
 */
@Component({
  selector: 'app-scatter-plot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="relative">
      <svg
        [attr.viewBox]="'0 0 ' + W + ' ' + H"
        preserveAspectRatio="xMidYMid meet"
        class="w-full block"
        [style.height.px]="H"
      >
        <rect x="0" y="0" [attr.width]="W" [attr.height]="H" fill="rgb(9, 9, 11)"/>

        <!-- Axes -->
        <line [attr.x1]="cx" [attr.x2]="cx" y1="0" [attr.y2]="H"
              stroke="rgb(63, 63, 70)" stroke-width="1"/>
        <line [attr.y1]="cy" [attr.y2]="cy" x1="0" [attr.x2]="W"
              stroke="rgb(63, 63, 70)" stroke-width="1"/>

        <!-- Grid circles at e/2, e -->
        @for (r of gridRadii(); track r) {
          <circle [attr.cx]="cx" [attr.cy]="cy" [attr.r]="r"
                  fill="none" stroke="rgb(39, 39, 42)" stroke-width="1"
                  stroke-dasharray="3 3"/>
        }

        <!-- Axis labels — image coords (X right, Y down — matches preview) -->
        <text [attr.x]="W - 4" [attr.y]="cy - 4"
              text-anchor="end" font-size="9" font-family="ui-monospace, monospace"
              fill="rgb(113, 113, 122)">X→</text>
        <text [attr.x]="cx + 4" [attr.y]="H - 4"
              font-size="9" font-family="ui-monospace, monospace"
              fill="rgb(113, 113, 122)">Y↓</text>

        <!-- Extent label -->
        <text x="3" [attr.y]="H - 3"
              font-size="9" font-family="ui-monospace, monospace"
              fill="rgb(82, 82, 91)">±{{ extent() | number:'1.0-1' }}px</text>

        <!-- Points: oldest faint, newest bright -->
        @for (pt of plotPoints(); track $index) {
          <circle
            [attr.cx]="pt.x" [attr.cy]="pt.y"
            [attr.r]="pt.r"
            [attr.fill]="pt.fill"
            [attr.fill-opacity]="pt.alpha"
          />
        }

        <!-- Latest point pulse -->
        @if (latest(); as l) {
          <circle [attr.cx]="l.x" [attr.cy]="l.y" r="6"
                  fill="none" stroke="rgb(52, 211, 153)" stroke-width="1.5">
            <animate attributeName="r" values="3;10;3" dur="1.5s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="1;0;1" dur="1.5s" repeatCount="indefinite"/>
          </circle>
        }
      </svg>
    </div>
  `,
})
export class ScatterPlotComponent {
  points = input.required<DriftPoint[]>();

  readonly W = 160;
  readonly H = 160;
  readonly cx = 80;
  readonly cy = 80;

  /** Auto-scale to data, but never tighter than ±5 px so a tight cluster
   *  is still visible. Cap at 99th percentile so a single outlier doesn't
   *  shrink everything. */
  extent = computed(() => {
    const pts = this.points();
    if (!pts.length) return 5;
    const mags: number[] = [];
    for (const p of pts) {
      mags.push(Math.abs(p.dx));
      mags.push(Math.abs(p.dy));
    }
    mags.sort((a, b) => a - b);
    const p99 = mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.99))];
    return Math.max(5, Math.ceil(p99 * 1.1));
  });

  gridRadii = computed(() => {
    const e = this.extent();
    const half = (this.W - 16) / 2;
    return [half / 2, half];
  });

  plotPoints = computed(() => {
    const pts = this.points();
    const e = this.extent();
    const half = (this.W - 16) / 2;
    const n = pts.length;
    const out: { x: number; y: number; r: number; fill: string; alpha: number }[] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const x = this.cx + (p.dx / e) * half;
      // Image convention — Y axis down, matching the preview frame.
      const y = this.cy + (p.dy / e) * half;
      // Newer points are bigger and brighter
      const ageNorm = i / Math.max(1, n - 1); // 0 = oldest, 1 = newest
      const r = 1.4 + ageNorm * 1.6;
      const alpha = 0.15 + ageNorm * 0.7;
      out.push({ x, y, r, fill: 'rgb(229, 231, 235)', alpha });
    }
    return out;
  });

  latest = computed(() => {
    const pts = this.plotPoints();
    return pts.length ? pts[pts.length - 1] : null;
  });
}
