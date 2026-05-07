import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type ReticleStyle =
  | 'classic'
  | 'scifi'
  | 'fighter'
  | 'tank'
  | 'finder'
  | 'sniper';

export const RETICLE_LABELS: Record<ReticleStyle, string> = {
  classic: 'Classic',
  scifi: 'Sci-fi HUD',
  fighter: 'Fighter HUD',
  tank: 'Tank gunner',
  finder: 'Finder scope',
  sniper: 'Sniper duplex',
};

export const RETICLES: ReticleStyle[] = ['classic', 'scifi', 'fighter', 'tank', 'finder', 'sniper'];

/**
 * Reticle overlay drawn on the frame view at the configured center point.
 *
 * All sizes are in sensor-pixel units (parent SVG uses a viewBox sized to
 * the sensor); the parent scales `len`/`stroke` so each style reads at a
 * consistent on-screen size regardless of sensor resolution.
 *
 * Each style is a distinct visual language — pick the one that fits your
 * mood for the night. Functionally identical (centered crosshair); the
 * difference is what's *around* the center.
 */
@Component({
  selector: 'g[appReticle]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (style()) {
      @case ('classic') {
        <svg:g pointer-events="none">
          <svg:line [attr.x1]="-len()" [attr.x2]="len()" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke()"/>
          <svg:line x1="0" x2="0" [attr.y1]="-len()" [attr.y2]="len()"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke()"/>
          <svg:circle r="3" [attr.fill]="color()"/>
        </svg:g>
      }

      @case ('scifi') {
        <svg:g pointer-events="none">
          <svg:circle [attr.r]="len() * 1.4" fill="none"
                  [attr.stroke]="color()"
                  vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.6"
                  stroke-dasharray="6 4"
                  class="anim-spin"/>
          <svg:g [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke()"
             fill="none" stroke-linecap="round">
            <svg:path [attr.d]="brackets()"/>
          </svg:g>
          <svg:line [attr.x1]="-len() * 0.45" [attr.x2]="-len() * 0.15" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.2"/>
          <svg:line [attr.x1]="len() * 0.45" [attr.x2]="len() * 0.15" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.2"/>
          <svg:line x1="0" x2="0" [attr.y1]="-len() * 0.45" [attr.y2]="-len() * 0.15"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.2"/>
          <svg:line x1="0" x2="0" [attr.y1]="len() * 0.45" [attr.y2]="len() * 0.15"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.2"/>
          <svg:circle r="2.5" [attr.fill]="color()"/>
          <svg:circle [attr.r]="len() * 0.18" fill="none"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.6"/>
        </svg:g>
      }

      @case ('fighter') {
        <svg:g pointer-events="none">
          <svg:circle r="2" [attr.fill]="color()"/>
          <svg:circle [attr.r]="len() * 0.28" fill="none"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke()"/>
          <svg:g [attr.fill]="color()">
            @for (i of milTicks; track i) {
              <svg:circle [attr.cx]="i * len() * 0.18" cy="0" [attr.r]="stroke() * 0.7"/>
              <svg:circle cx="0" [attr.cy]="i * len() * 0.18" [attr.r]="stroke() * 0.7"/>
            }
          </svg:g>
          <svg:line [attr.x1]="-len() * 1.05" [attr.x2]="-len() * 0.55" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.4"/>
          <svg:line [attr.x1]="len() * 0.55" [attr.x2]="len() * 1.05" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.4"/>
          <svg:line x1="0" x2="0" [attr.y1]="len() * 0.55" [attr.y2]="len() * 1.05"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.4"/>
        </svg:g>
      }

      @case ('tank') {
        <svg:g pointer-events="none">
          <svg:line x1="-3" x2="3" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.2"/>
          <svg:line x1="0" x2="0" y1="-3" y2="3"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.2"/>
          <svg:line [attr.x1]="-len()" [attr.x2]="-len() * 0.3" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.6"/>
          <svg:line [attr.x1]="len() * 0.3" [attr.x2]="len()" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.6"/>
          @for (c of chevrons; track c.scale; let i = $index) {
            <svg:path
              [attr.d]="chevronPath(c.scale, i)"
              fill="none"
              [attr.stroke]="color()"
              vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 1.4"
              stroke-linejoin="miter"/>
          }
          @for (t of dropTicks; track t) {
            <svg:line [attr.x1]="-len() * 0.06" [attr.x2]="len() * 0.06"
                  [attr.y1]="t * len() * 0.20" [attr.y2]="t * len() * 0.20"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke()"/>
          }
        </svg:g>
      }

      @case ('finder') {
        <svg:g pointer-events="none">
          <svg:circle [attr.r]="len() * 1.0" fill="none"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.6"
                  stroke-opacity="0.6"/>
          <svg:circle [attr.r]="len() * 0.5" fill="none"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.5"
                  stroke-opacity="0.45"/>
          <svg:line [attr.x1]="-len() * 1.15" [attr.x2]="-len() * 0.06" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          <svg:line [attr.x1]="len() * 0.06" [attr.x2]="len() * 1.15" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          <svg:line x1="0" x2="0" [attr.y1]="-len() * 1.15" [attr.y2]="-len() * 0.06"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          <svg:line x1="0" x2="0" [attr.y1]="len() * 0.06" [attr.y2]="len() * 1.15"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          @for (t of finderTicks; track t) {
            <svg:line [attr.x1]="t * len()" [attr.x2]="t * len()"
                  [attr.y1]="-len() * 0.04" [attr.y2]="len() * 0.04"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.6"/>
            <svg:line [attr.x1]="-len() * 0.04" [attr.x2]="len() * 0.04"
                  [attr.y1]="t * len()" [attr.y2]="t * len()"
                  [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.6"/>
          }
          <svg:circle r="1.5" [attr.fill]="color()"/>
        </svg:g>
      }

      @case ('sniper') {
        <svg:g pointer-events="none">
          <svg:line [attr.x1]="-len() * 1.15" [attr.x2]="-len() * 0.40" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 2.4"/>
          <svg:line [attr.x1]="len() * 0.40" [attr.x2]="len() * 1.15" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 2.4"/>
          <svg:line x1="0" x2="0" [attr.y1]="-len() * 1.15" [attr.y2]="-len() * 0.40"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 2.4"/>
          <svg:line x1="0" x2="0" [attr.y1]="len() * 0.40" [attr.y2]="len() * 1.15"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 2.4"/>
          <svg:line [attr.x1]="-len() * 0.40" [attr.x2]="-len() * 0.05" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          <svg:line [attr.x1]="len() * 0.05" [attr.x2]="len() * 0.40" y1="0" y2="0"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          <svg:line x1="0" x2="0" [attr.y1]="-len() * 0.40" [attr.y2]="-len() * 0.05"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          <svg:line x1="0" x2="0" [attr.y1]="len() * 0.05" [attr.y2]="len() * 0.40"
                [attr.stroke]="color()" vector-effect="non-scaling-stroke" [attr.stroke-width]="stroke() * 0.7"/>
          @for (i of milTicks; track i) {
            <svg:circle [attr.cx]="i * len() * 0.10" cy="0"
                    [attr.r]="stroke() * 0.6" [attr.fill]="color()"/>
            <svg:circle cx="0" [attr.cy]="i * len() * 0.10"
                    [attr.r]="stroke() * 0.6" [attr.fill]="color()"/>
          }
        </svg:g>
      }
    }
  `,
  styles: [`
    /* SVG element rotation needs an explicit origin. transform-box: fill-box
     * targets the element's own bounding box; combined with transform-origin
     * 50% 50% the rotation pivots around the element centre, which for a
     * concentric circle = the reticle centre point.
     */
    .anim-spin {
      animation: reticle-spin 24s linear infinite;
      transform-box: fill-box;
      transform-origin: 50% 50%;
    }
    @keyframes reticle-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `],
})
export class ReticleComponent {
  style = input.required<ReticleStyle>();
  color = input<string>('rgb(125, 211, 252)');
  stroke = input<number>(2);
  len = input<number>(60);

  readonly milTicks = [-3, -2, -1, 1, 2, 3];
  readonly chevrons = [{ scale: 1.0 }, { scale: 0.7 }, { scale: 0.45 }];
  readonly dropTicks = [1, 2, 3, 4];
  readonly finderTicks = [-0.75, -0.50, -0.25, 0.25, 0.50, 0.75];

  brackets = computed(() => {
    const l = this.len();
    const arm = l * 0.25;
    const off = l * 1.05;
    return [
      `M ${-off} ${-off + arm} L ${-off} ${-off} L ${-off + arm} ${-off}`,
      `M ${off - arm} ${-off} L ${off} ${-off} L ${off} ${-off + arm}`,
      `M ${off} ${off - arm} L ${off} ${off} L ${off - arm} ${off}`,
      `M ${-off + arm} ${off} L ${-off} ${off} L ${-off} ${off - arm}`,
    ].join(' ');
  });

  chevronPath(scale: number, i: number): string {
    const l = this.len();
    const w = l * 0.16 * scale;
    const yBase = -l * 0.30 - i * l * 0.10;
    const yTip = -l * 0.40 - i * l * 0.10;
    return `M ${-w} ${yBase} L 0 ${yTip} L ${w} ${yBase}`;
  }
}
