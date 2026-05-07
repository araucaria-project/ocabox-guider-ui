import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuiderStore, PipelineState } from '../services/guider.store';
import { ReticleComponent, ReticleStyle } from './reticle.component';

interface View {
  zoom: number;
  panX: number;
  panY: number;
}

const HOME_VIEW: View = { zoom: 1, panX: 0, panY: 0 };
const ZOOM_MIN = 1;
const ZOOM_MAX = 16;
const BUTTON_FACTOR = 1.5;
const WHEEL_FACTOR = 1.2;

/**
 * Live frame view with SVG overlays and pan/zoom.
 *
 * - The JPEG renders at its natural aspect ratio (object-contain).
 * - SVG sits on top with `viewBox` set to sensor pixels, so all overlay
 *   coordinates are already in sensor space — no client/scale math needed.
 * - A click on the SVG yields exact sensor coordinates (the inverse-CTM
 *   walk through any CSS transform keeps this correct under zoom).
 *
 * Zoom model (sparse, no effects):
 *   - `view = { zoom, panX, panY }` is the only mutable state.
 *   - Buttons zoom around the centre; mouse-wheel zooms around the cursor
 *     (preserves the image-coord under the pointer).
 *   - Pan is clamped so the wrapper always covers the host rect — no
 *     black bands. At `zoom === 1` pan snaps back to (0, 0) (home).
 */
@Component({
  selector: 'app-frame-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ReticleComponent],
  template: `
    <div class="relative w-full h-full bg-black select-none overflow-hidden" #host>
      <!-- Pan/zoom wrapper. Holds both image and SVG so they stay aligned;
           getScreenCTM() picks up the CSS transform automatically. -->
      <div
        class="absolute inset-0 origin-top-left will-change-transform"
        [style.transform]="transformStyle()"
      >
        @if (thumbnailUrl(); as url) {
          <img
            class="thumb-canvas absolute inset-0 w-full h-full object-contain"
            [src]="url"
            alt="latest guider frame">
        } @else {
          <div class="absolute inset-0 grid place-items-center text-xs text-zinc-600">
            waiting for first frame…
          </div>
        }

        <svg
          class="absolute inset-0 w-full h-full"
          [attr.viewBox]="'0 0 ' + sensorWidth() + ' ' + sensorHeight()"
          preserveAspectRatio="xMidYMid meet"
          (click)="onSvgClick($event)"
          (mousemove)="onSvgMove($event)"
          (mouseleave)="hoverPos.set(null)"
          #svg
        >
          @if (state(); as s) {
            <!-- Search circle = wide_search_radius_px around central_point. -->
            <circle
              [attr.cx]="s.central_point[0]"
              [attr.cy]="s.central_point[1]"
              [attr.r]="s.wide_search_radius_px"
              fill="none"
              stroke="rgba(125, 211, 252, 0.5)"
              [attr.stroke-width]="overlayStrokePx()"
              vector-effect="non-scaling-stroke"
              stroke-dasharray="14,8"
              pointer-events="none"
            />

            <!-- Centre reticle (operator's target). Style is selectable. -->
            <g
              appReticle
              [style]="reticle()"
              [color]="reticleColor"
              [len]="overlayCrossPx()"
              [stroke]="overlayStrokePx()"
              [attr.transform]="'translate(' + s.central_point[0] + ',' + s.central_point[1] + ')'"
            ></g>

            <!-- Acquired star marker (where solver locked on). -->
            @if (s.acquired && s.acquired_pos) {
              <g
                [attr.transform]="'translate(' + s.acquired_pos[0] + ',' + s.acquired_pos[1] + ')'"
                pointer-events="none"
              >
                <circle
                  [attr.r]="overlayMarkerPx()"
                  fill="none"
                  stroke="rgb(52, 211, 153)"
                  [attr.stroke-width]="overlayStrokePx() * 1.5"
                  vector-effect="non-scaling-stroke"
                />
                <circle
                  [attr.r]="overlayMarkerPx() * 0.18"
                  fill="rgb(52, 211, 153)"
                />
                <text
                  [attr.x]="overlayMarkerPx() + 4"
                  y="-4"
                  fill="rgb(52, 211, 153)"
                  [attr.font-size]="overlayLabelPx()"
                  font-family="ui-monospace, monospace"
                >
                  {{ s.acquired_adu | number:'1.0-0' }} ADU
                </text>
              </g>

              <!-- Vector from central → acquired (visible drift error). -->
              <line
                [attr.x1]="s.central_point[0]"
                [attr.y1]="s.central_point[1]"
                [attr.x2]="s.acquired_pos[0]"
                [attr.y2]="s.acquired_pos[1]"
                stroke="rgba(52, 211, 153, 0.45)"
                [attr.stroke-width]="overlayStrokePx() * 0.9"
                vector-effect="non-scaling-stroke"
                pointer-events="none"
              />
            }

            <!-- Search-region box (narrow re-acquisition window) on acquired_pos. -->
            @if (s.acquired && s.acquired_pos) {
              <rect
                [attr.x]="s.acquired_pos[0] - s.search_reg_px / 2"
                [attr.y]="s.acquired_pos[1] - s.search_reg_px / 2"
                [attr.width]="s.search_reg_px"
                [attr.height]="s.search_reg_px"
                fill="none"
                stroke="rgba(52, 211, 153, 0.5)"
                [attr.stroke-width]="overlayStrokePx() * 0.8"
                vector-effect="non-scaling-stroke"
                stroke-dasharray="3,3"
                pointer-events="none"
              />
            }

            <!-- Scale bar: 100 px reference at the bottom-left. -->
            <g
              [attr.transform]="'translate(' + (sensorWidth() * 0.04) + ',' + (sensorHeight() * 0.94) + ')'"
              pointer-events="none"
            >
              <line
                x1="0" x2="100"
                y1="0" y2="0"
                stroke="rgba(244, 244, 245, 0.85)"
                [attr.stroke-width]="overlayStrokePx() * 1.2"
                vector-effect="non-scaling-stroke"
              />
              <text
                x="50" y="-6"
                text-anchor="middle"
                fill="rgba(244, 244, 245, 0.9)"
                [attr.font-size]="overlayLabelPx()"
                font-family="ui-monospace, monospace"
              >
                100 px
              </text>
            </g>
          }

          @if (hoverPos(); as h) {
            <!-- Pointer reticle while hovering — shows future click target. -->
            <g
              [attr.transform]="'translate(' + h[0] + ',' + h[1] + ')'"
              pointer-events="none"
            >
              <circle
                r="14"
                fill="none"
                stroke="rgba(244, 244, 245, 0.55)"
                [attr.stroke-width]="overlayStrokePx() * 0.8"
                vector-effect="non-scaling-stroke"
              />
              <line x1="-22" x2="-6" y1="0" y2="0" stroke="rgba(244, 244, 245, 0.55)" [attr.stroke-width]="overlayStrokePx() * 0.8" vector-effect="non-scaling-stroke"/>
              <line x1="6" x2="22" y1="0" y2="0" stroke="rgba(244, 244, 245, 0.55)" [attr.stroke-width]="overlayStrokePx() * 0.8" vector-effect="non-scaling-stroke"/>
              <line x1="0" x2="0" y1="-22" y2="-6" stroke="rgba(244, 244, 245, 0.55)" [attr.stroke-width]="overlayStrokePx() * 0.8" vector-effect="non-scaling-stroke"/>
              <line x1="0" x2="0" y1="6" y2="22" stroke="rgba(244, 244, 245, 0.55)" [attr.stroke-width]="overlayStrokePx() * 0.8" vector-effect="non-scaling-stroke"/>
            </g>
          }
        </svg>
      </div>

      <!-- ─── Zoom controls ─── -->
      <div class="absolute top-1 right-1 flex flex-col gap-0.5 z-10">
        <button
          type="button"
          (click)="zoomIn()"
          [disabled]="view().zoom >= ZOOM_MAX"
          title="zoom in (+)"
          class="w-7 h-7 rounded bg-zinc-900/80 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-zinc-900/80 text-zinc-200 grid place-items-center"
        >
          <!-- magnifier + -->
          <svg viewBox="0 0 16 16" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.25"/>
            <line x1="10.2" y1="10.2" x2="14" y2="14"/>
            <line x1="5" y1="7" x2="9" y2="7"/>
            <line x1="7" y1="5" x2="7" y2="9"/>
          </svg>
        </button>
        <button
          type="button"
          (click)="zoomOut()"
          [disabled]="view().zoom <= ZOOM_MIN"
          title="zoom out (-)"
          class="w-7 h-7 rounded bg-zinc-900/80 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-zinc-900/80 text-zinc-200 grid place-items-center"
        >
          <!-- magnifier - -->
          <svg viewBox="0 0 16 16" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.25"/>
            <line x1="10.2" y1="10.2" x2="14" y2="14"/>
            <line x1="5" y1="7" x2="9" y2="7"/>
          </svg>
        </button>
        <button
          type="button"
          (click)="home()"
          [disabled]="!canResetZoom()"
          title="reset zoom (0)"
          class="w-7 h-7 rounded bg-zinc-900/80 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-zinc-900/80 text-zinc-200 grid place-items-center text-[10px] font-mono"
        >
          1:1
        </button>
      </div>

      <!-- Zoom indicator: only shown while zoomed. -->
      @if (view().zoom !== 1) {
        <div class="absolute top-1 left-1 text-[10px] font-mono text-zinc-200 bg-black/50 px-1.5 py-0.5 rounded z-10 pointer-events-none">
          {{ zoomLabel() }}
        </div>
      }

      <!-- Coordinate readouts in the bottom-right corner (in screen space,
           not transformed — they always sit on the viewport). -->
      <div class="absolute bottom-1 right-2 flex flex-col items-end gap-0.5 text-[10px] font-mono text-zinc-300 pointer-events-none z-10">
        @if (hoverPos(); as h) {
          <div class="bg-black/50 px-1.5 py-0.5 rounded">
            cursor ({{ h[0] | number:'1.0-0' }}, {{ h[1] | number:'1.0-0' }})
          </div>
        }
        @if (state()?.acquired_pos; as p) {
          <div class="bg-black/50 px-1.5 py-0.5 rounded text-emerald-300">
            star ({{ p[0] | number:'1.0-0' }}, {{ p[1] | number:'1.0-0' }})
          </div>
        }
      </div>
    </div>
  `,
})
export class FrameViewComponent {
  store = inject(GuiderStore);
  private hostRef = inject(ElementRef<HTMLElement>);

  state = input.required<PipelineState | undefined>();
  instance = input.required<string>();
  /** Sensor pixel extents — passed in so the parent can update them as
   *  knowledge improves. Defaults match the BESO sensor (1936 × 1216). */
  sensorWidth = input<number>(1936);
  sensorHeight = input<number>(1216);
  /** Reticle drawing style for the central-point overlay. */
  reticle = input<ReticleStyle>('classic');

  /** Reticle colour — kept fixed for now to stay coherent with the other
   *  cyan overlays (search circle, scale bar). */
  readonly reticleColor = 'rgba(125, 211, 252, 0.85)';

  /** Fired when the user clicks on the field — coordinates are sensor pixels. */
  acquireAt = output<{ x: number; y: number }>();

  hoverPos = signal<[number, number] | null>(null);

  /** Pan/zoom state. The single source of truth — all derived values
   *  (transform, indicator visibility, button enablement) flow from it. */
  view = signal<View>(HOME_VIEW);

  readonly ZOOM_MIN = ZOOM_MIN;
  readonly ZOOM_MAX = ZOOM_MAX;

  private host = viewChild<ElementRef<HTMLElement>>('host');

  thumbnailUrl = computed<string | null>(() => {
    const note = this.store.thumbnails().get(this.instance());
    if (!note) return null;
    return this.store.resolveThumbnailUrl(note.path);
  });

  transformStyle = computed(() => {
    const v = this.view();
    return `translate(${v.panX}px, ${v.panY}px) scale(${v.zoom})`;
  });

  zoomLabel = computed(() => `${Math.round(this.view().zoom * 100)}%`);
  canResetZoom = computed(() => {
    const v = this.view();
    return v.zoom !== 1 || v.panX !== 0 || v.panY !== 0;
  });

  /**
   * Strokes / labels are sized in sensor-pixel units (because of viewBox);
   * we want them to *appear* a constant size on screen. Tuned visually
   * against a 1936×1216 sensor at common viewports — roughly 2–3 screen
   * pixels for stroke widths and 12px for labels.
   *
   * Under zoom these grow with the image (the SVG sits inside the
   * CSS-transformed wrapper). That's intentional: scaling overlays with
   * zoom keeps them sharp (no bitmap-rescale), and at high zoom the
   * overlays remain visible relative to the now-larger image features.
   * Stroke widths use ``vector-effect="non-scaling-stroke"`` so lines
   * stay crisp at the same screen-pixel width regardless of zoom.
   */
  overlayStrokePx = computed(() => Math.max(this.sensorWidth(), this.sensorHeight()) / 500);
  overlayCrossPx = computed(() => Math.max(this.sensorWidth(), this.sensorHeight()) / 22);
  overlayMarkerPx = computed(() => Math.max(this.sensorWidth(), this.sensorHeight()) / 50);
  overlayLabelPx = computed(() => Math.max(this.sensorWidth(), this.sensorHeight()) / 55);

  constructor() {
    // Attach a non-passive wheel listener so we can preventDefault
    // (Angular template event bindings are passive for wheel events).
    afterNextRender(() => {
      const el = this.hostRef.nativeElement as HTMLElement;
      el.addEventListener('wheel', (ev) => this.onWheel(ev as WheelEvent), { passive: false });
    });
  }

  onSvgClick(ev: MouseEvent): void {
    const pt = this.svgPoint(ev);
    if (!pt) return;
    this.acquireAt.emit({ x: pt[0], y: pt[1] });
  }

  onSvgMove(ev: MouseEvent): void {
    const pt = this.svgPoint(ev);
    this.hoverPos.set(pt);
  }

  zoomIn(): void { this.zoomBy(BUTTON_FACTOR, null); }
  zoomOut(): void { this.zoomBy(1 / BUTTON_FACTOR, null); }
  home(): void { this.view.set(HOME_VIEW); }

  /** Zoom by ``factor`` around ``pivot`` (host-relative coords). When
   *  ``pivot`` is null the host centre is used (button behaviour). */
  private zoomBy(factor: number, pivot: { x: number; y: number } | null): void {
    const host = this.host()?.nativeElement;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const v = this.view();
    const nz = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (nz === v.zoom) return;
    const px = pivot?.x ?? rect.width / 2;
    const py = pivot?.y ?? rect.height / 2;
    // image-space coord under the pivot before the change
    const imgX = (px - v.panX) / v.zoom;
    const imgY = (py - v.panY) / v.zoom;
    let newPanX = px - imgX * nz;
    let newPanY = py - imgY * nz;
    if (nz === 1) {
      newPanX = 0;
      newPanY = 0;
    } else {
      newPanX = clamp(newPanX, -(nz - 1) * rect.width, 0);
      newPanY = clamp(newPanY, -(nz - 1) * rect.height, 0);
    }
    this.view.set({ zoom: nz, panX: newPanX, panY: newPanY });
  }

  private onWheel(ev: WheelEvent): void {
    const host = this.host()?.nativeElement;
    if (!host) return;
    ev.preventDefault();
    const rect = host.getBoundingClientRect();
    const factor = ev.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
    this.zoomBy(factor, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  }

  private svgPoint(ev: MouseEvent): [number, number] | null {
    const svg = ev.currentTarget as SVGSVGElement | null;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const inverse = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const local = pt.matrixTransform(inverse);
    return [local.x, local.y];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
