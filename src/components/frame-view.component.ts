import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuiderStore, PipelineState, ThumbnailNotification } from '../services/guider.store';
import { ReticleComponent, ReticleStyle } from './reticle.component';

interface View {
  zoom: number;
  panX: number;
  panY: number;
}

const HOME_VIEW: View = { zoom: 1, panX: 0, panY: 0 };

/** Render a duration in human-friendly units. Operators read frames
 *  on the order of a few hundred ms (cadence) to tens of seconds
 *  (slow links, long exposures); raw "12345 ms" forces them to count
 *  digits. Sub-second → "850 ms"; sub-minute → "12.3 s"; longer
 *  → "2 min 14 s". */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m} min ${r} s`;
}
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
        @if (displayedUrl(); as url) {
          <img
            class="thumb-canvas absolute inset-0 w-full h-full object-contain"
            [src]="url"
            (load)="onImageLoad()"
            (error)="onImageError()"
            alt="latest guider frame">
        } @else {
          <div class="absolute inset-0 grid place-items-center text-xs text-zinc-600">
            waiting for first frame…
          </div>
        }

        <!-- Two-line overlay. Top line = LATEST notification (system
             aliveness — UTC clock, age since exposure, exp time).
             Bottom line = DISPLAYED frame (what's actually on screen)
             with the image-lag indicator. On a fast link they're the
             same frame; on a slow one the gap tells the operator
             exactly how stale the visible image is in human units. -->
        @if (latestMeta(); as lm) {
          <div class="absolute top-1 left-1 px-1.5 py-0.5 text-[10px]
                      font-mono leading-tight text-zinc-100
                      bg-black/55 rounded pointer-events-none">
            <div [class.text-amber-300]="lm.ageStale">
              {{ lm.utc }} · {{ lm.ageStr }}
              · #{{ lm.seq }} · exp {{ lm.expStr }}
            </div>
            @if (imageLag(); as lag) {
              <div class="text-amber-300">
                ↻ showing #{{ lag.shownSeq }} ({{ lag.gapStr }} behind)
              </div>
            }
          </div>
        }

        <svg
          class="absolute inset-0 w-full h-full"
          [attr.viewBox]="'0 0 ' + sensorWidth() + ' ' + sensorHeight()"
          preserveAspectRatio="xMidYMid meet"
          (click)="onSvgClick($event)"
          (contextmenu)="onSvgContext($event)"
          (mousemove)="onSvgMove($event)"
          (mouseleave)="hoverPos.set(null)"
          #svg
        >
          @if (state(); as s) {
            <!-- All FFS detections (debug overlay). Toggled by the
                 telescope-icon button next to zoom controls. Best-rank
                 candidate is highlighted; TAB cycles lock_at through
                 the list in rank order. -->
            @if (showCandidates() && s.candidates && s.candidates.length > 0) {
              @for (c of s.candidates; track $index; let i = $index) {
                <circle
                  [attr.cx]="c[0]"
                  [attr.cy]="c[1]"
                  [attr.r]="overlayMarkerPx() * 0.7"
                  fill="none"
                  [attr.stroke]="i === selectedCandidateIndex() ? 'rgba(251, 191, 36, 0.95)' : 'rgba(125, 211, 252, 0.45)'"
                  [attr.stroke-width]="i === selectedCandidateIndex() ? overlayStrokePx() * 1.2 : overlayStrokePx() * 0.7"
                  vector-effect="non-scaling-stroke"
                  pointer-events="none"
                />
              }
            }

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

            <!-- Centre reticle (operator's target). Style is selectable;
                 'none' suppresses the overlay entirely (used when star
                 is in the fibre and any marker would obscure pixels). -->
            @if (reticle() !== 'none') {
              <g
                appReticle
                [style]="reticle()"
                [color]="reticleColor"
                [len]="overlayCrossPx()"
                [stroke]="overlayStrokePx()"
                [attr.transform]="'translate(' + s.central_point[0] + ',' + s.central_point[1] + ')'"
              ></g>
            }

            <!-- Guide anchor (where guiding holds the star). Only shown
                 in guiding mode; uses an amber X to distinguish from the
                 cyan central reticle (target) and the green acquired
                 marker (current star position). -->
            @if (s.guide_anchor) {
              <g
                [attr.transform]="'translate(' + s.guide_anchor[0] + ',' + s.guide_anchor[1] + ')'"
                pointer-events="none"
              >
                <!-- Broken X: 4 short segments with a gap at the centre
                     so the pixel under the anchor (= the fibre hole at
                     zoom) stays visible. -->
                <line x1="-12" y1="-12" x2="-3" y2="-3"
                      stroke="rgba(251, 191, 36, 0.85)"
                      [attr.stroke-width]="overlayStrokePx() * 1.4"
                      vector-effect="non-scaling-stroke"/>
                <line x1="3" y1="3" x2="12" y2="12"
                      stroke="rgba(251, 191, 36, 0.85)"
                      [attr.stroke-width]="overlayStrokePx() * 1.4"
                      vector-effect="non-scaling-stroke"/>
                <line x1="-12" y1="12" x2="-3" y2="3"
                      stroke="rgba(251, 191, 36, 0.85)"
                      [attr.stroke-width]="overlayStrokePx() * 1.4"
                      vector-effect="non-scaling-stroke"/>
                <line x1="3" y1="-3" x2="12" y2="-12"
                      stroke="rgba(251, 191, 36, 0.85)"
                      [attr.stroke-width]="overlayStrokePx() * 1.4"
                      vector-effect="non-scaling-stroke"/>
              </g>
            }

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

      <!-- ─── Zoom + overlay controls ─── -->
      <div class="absolute top-1 right-1 flex flex-col gap-0.5 z-10">
        <button
          type="button"
          (click)="toggleCandidates()"
          [class]="showCandidates() ? 'bg-amber-700/80 hover:bg-amber-700 text-amber-50' : 'bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200'"
          [title]="showCandidates() ? 'hide detection circles (currently shown — TAB cycles lock)' : 'show all detection candidates as circles (TAB cycles lock through them)'"
          class="w-7 h-7 rounded disabled:opacity-30 grid place-items-center"
        >
          <!-- detection-overlay icon: outer dotted circle + inner dot -->
          <svg viewBox="0 0 16 16" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="8" cy="8" r="6" stroke-dasharray="2 1.5"/>
            <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>
          </svg>
        </button>
        <div class="h-1"></div>
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
            cursor ({{ h[0] | number:'1.2-2' }}, {{ h[1] | number:'1.2-2' }})
          </div>
        }
        @if (state()?.acquired_pos; as p) {
          <div class="bg-black/50 px-1.5 py-0.5 rounded text-emerald-300">
            star ({{ p[0] | number:'1.2-2' }}, {{ p[1] | number:'1.2-2' }})
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

  /** Left-click on the frame — routine "lock onto a star near (x, y)".
   *  Server narrow-search refines to the actual star peak; doesn't move
   *  the mount, doesn't change central_point. Sensor-pixel coords. */
  lockAt = output<{ x: number; y: number }>();

  /** Right-click on the frame — admin "move target reticle to (x, y)".
   *  Changes ``central_point`` and forces the next wide-search to fire
   *  around the new target. Rare operator action. Sensor-pixel coords. */
  acquireAt = output<{ x: number; y: number }>();

  hoverPos = signal<[number, number] | null>(null);

  /** Pan/zoom state. The single source of truth — all derived values
   *  (transform, indicator visibility, button enablement) flow from it. */
  view = signal<View>(HOME_VIEW);

  /** Detection-circles overlay toggle. Persists through localStorage so
   *  it survives reloads — operators who like seeing the population
   *  don't have to keep re-enabling. */
  showCandidates = signal<boolean>(this.loadShowCandidates());
  /** Index into ``state.candidates`` for which circle is highlighted.
   *  Driven by TAB key (next) / Shift-TAB (prev) and reset to 0 on
   *  every fresh candidate list. ``-1`` means nothing highlighted. */
  selectedCandidateIndex = signal<number>(-1);

  readonly ZOOM_MIN = ZOOM_MIN;
  readonly ZOOM_MAX = ZOOM_MAX;

  private host = viewChild<ElementRef<HTMLElement>>('host');

  /** Load-serialising image swap. Slow links (VPN) can't pull a
   *  notification's JPEG before the next one arrives. Naively binding
   *  ``<img [src]>`` to the latest URL aborts the in-flight fetch
   *  every time, so the browser never finishes any image and the
   *  displayed frame freezes — while the metadata races ahead.
   *
   *  Pattern: keep two signals — ``displayedNote`` is what the user
   *  actually sees; ``latestNote`` is the most recent notification.
   *  When ``latestNote`` arrives we adopt it as ``displayedNote``
   *  only if nothing is currently loading; otherwise we wait for the
   *  ``(load)`` event to flush the queue. This gives natural
   *  rate-limiting that matches the operator's actual bandwidth —
   *  every frame visible was fully fetched. The ``↻ +N`` badge tells
   *  them how far behind the display is. */
  private displayedNote = signal<ThumbnailNotification | null>(null);
  private latestNote = computed<ThumbnailNotification | null>(() =>
    this.store.thumbnails().get(this.instance()) ?? null,
  );
  private imageLoading = signal<boolean>(false);

  displayedUrl = computed<string | null>(() => {
    const note = this.displayedNote();
    if (!note) {
      // Initial: nothing displayed yet — adopt the very first
      // notification synchronously so the first frame appears
      // without waiting for an onload that hasn't been bound yet.
      const first = this.latestNote();
      return first ? this.store.resolveThumbnailUrl(first.path) : null;
    }
    return this.store.resolveThumbnailUrl(note.path);
  });

  /** ``now`` ticker for live "age of frame" display. Re-evaluates
   *  every second so the overlay clock advances without waiting for a
   *  new notification. */
  private nowTick = signal<number>(Date.now());

  /** Parsed metadata for the LATEST notification — system aliveness
   *  display. Always reflects the freshest frame the guider has
   *  emitted, regardless of whether the browser has finished loading
   *  its JPEG. Operator sees the UTC clock advancing in real time;
   *  ``ageStale`` colour-codes when notifications themselves stop
   *  arriving (system stalled, not just slow link). */
  latestMeta = computed<{
    utc: string; ageStr: string; ageStale: boolean;
    seq: number; expStr: string;
  } | null>(() => {
    const note = this.latestNote();
    if (!note) return null;
    const ts = note.frame_ts;
    if (!Array.isArray(ts) || ts.length < 6) return null;
    const dt = Date.UTC(ts[0], ts[1] - 1, ts[2], ts[3], ts[4], ts[5],
                        Math.floor((ts[6] ?? 0) / 1000));
    if (Number.isNaN(dt)) return null;
    const now = this.nowTick();
    const ageMs = Math.max(0, now - dt);
    const expS = Number(note.exp_time_total ?? 0);
    const expMs = Math.round(expS * 1000);
    // Stale = no new notifications for 2× exp + 2 s (system not
    // producing frames). Distinct from image-lag (link too slow).
    const ageStale = ageMs > (expMs * 2 + 2000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const utc = `${ts[0]}-${pad(ts[1])}-${pad(ts[2])} `
              + `${pad(ts[3])}:${pad(ts[4])}:${pad(ts[5])}`;
    return {
      utc,
      ageStr: formatDuration(ageMs),
      ageStale,
      seq: Number(note.sequence ?? 0),
      expStr: formatDuration(expMs),
    };
  });

  /** Image lag — how far behind the displayed frame is, in both
   *  sequence gap and time. ``null`` when caught up (display = latest)
   *  or when no notifications received yet. */
  imageLag = computed<{ shownSeq: number; gap: number; gapStr: string } | null>(() => {
    const latest = this.latestNote();
    const displayed = this.displayedNote();
    if (!latest || !displayed) return null;
    const lseq = Number(latest.sequence ?? 0);
    const dseq = Number(displayed.sequence ?? 0);
    const gap = lseq - dseq;
    if (gap <= 0) return null;
    // Time gap: difference between latest and displayed frame_ts.
    // For most cadences this is approx ``gap × cadence_ms``; we
    // compute exactly because exposure can change mid-session.
    const lt = latest.frame_ts; const dt = displayed.frame_ts;
    let gapMs = 0;
    if (Array.isArray(lt) && Array.isArray(dt) && lt.length >= 6 && dt.length >= 6) {
      const l = Date.UTC(lt[0], lt[1] - 1, lt[2], lt[3], lt[4], lt[5],
                         Math.floor((lt[6] ?? 0) / 1000));
      const d = Date.UTC(dt[0], dt[1] - 1, dt[2], dt[3], dt[4], dt[5],
                         Math.floor((dt[6] ?? 0) / 1000));
      gapMs = Math.max(0, l - d);
    }
    return { shownSeq: dseq, gap, gapStr: formatDuration(gapMs) };
  });

  /** Browser finished loading the current image. Flush the queue:
   *  if a newer notification has arrived since we picked this one,
   *  advance to the newest one (skipping intermediates is OK and
   *  desirable on a slow link — we don't owe the operator every
   *  frame, just the freshest one we can sustain). */
  onImageLoad(): void {
    this.imageLoading.set(false);
    const latest = this.latestNote();
    if (latest && latest !== this.displayedNote()) {
      this.imageLoading.set(true);
      this.displayedNote.set(latest);
    }
  }

  /** 404 or network failure on an image fetch. Don't trap the queue:
   *  clear ``loading`` so the next notification can be tried, and let
   *  the operator see the symptom through the stale-age indicator. */
  onImageError(): void {
    this.imageLoading.set(false);
  }

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
    // Live age ticker — drives the frame-meta overlay's age readout
    // without waiting for a new thumbnail notification. 1 Hz is plenty
    // (operator's eye doesn't resolve faster than that for a ms-level
    // counter) and stays well under any plausible polling concern.
    const ticker = setInterval(() => this.nowTick.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(ticker));

    // First-frame priming: when the very first notification arrives,
    // adopt it as ``displayedNote`` so the load-serialising loop has
    // an initial state. Subsequent advances happen via ``onImageLoad``
    // — but the first frame has no prior ``onload`` to fire on, so we
    // bootstrap here. ``allowSignalWrites`` is needed because this
    // runs inside the reactive graph.
    effect(() => {
      const latest = this.latestNote();
      if (latest && this.displayedNote() === null) {
        this.imageLoading.set(true);
        this.displayedNote.set(latest);
      }
    }, { allowSignalWrites: true });

    // Stuck-load watchdog. If ``onImageLoad`` doesn't fire within 15 s
    // (network drop, image abort never resolves, browser quirk) AND a
    // newer notification has arrived, force-advance — better to retry
    // a fresh frame than wait forever. 15 s is generous: under VPN at
    // ~100 KB/s a 2 MB JPEG takes ~20 s legitimately, so we set the
    // ceiling slightly under that and instead advance only when the
    // pending queue is large enough that catching up is worth more
    // than finishing the current load.
    const watchdog = setInterval(() => {
      if (!this.imageLoading()) return;
      const latest = this.latestNote();
      const displayed = this.displayedNote();
      if (!latest || !displayed) return;
      const gap = Number(latest.sequence ?? 0) - Number(displayed.sequence ?? 0);
      if (gap >= 10) {
        // The displayed frame is so far behind that the operator is
        // better served by a fresh attempt than by waiting for the
        // in-flight load that may never complete.
        this.imageLoading.set(false);
        this.displayedNote.set(null);  // Drop to bootstrap; effect picks latest.
      }
    }, 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(watchdog));
  }

  onSvgClick(ev: MouseEvent): void {
    const pt = this.svgPoint(ev);
    if (!pt) return;
    this.lockAt.emit({ x: pt[0], y: pt[1] });
  }

  onSvgContext(ev: MouseEvent): void {
    // Right-click reassigns the operator's target reticle. Suppress the
    // browser context menu so the click reaches us.
    ev.preventDefault();
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

  toggleCandidates(): void {
    const next = !this.showCandidates();
    this.showCandidates.set(next);
    try { localStorage.setItem('frameview.showCandidates', next ? '1' : '0'); } catch { /* ignore */ }
    if (!next) this.selectedCandidateIndex.set(-1);
  }

  /** Step the highlighted candidate by ``delta`` (typically ±1 for
   *  TAB / Shift-TAB). Wraps around. Emits ``lockAt`` for the new
   *  selection so the operator immediately sees the lock move.
   *  Returns true if a candidate was selected, false if the list is
   *  empty/missing. */
  cycleCandidate(delta: number = 1): boolean {
    const list = this.state()?.candidates ?? null;
    if (!list || list.length === 0) return false;
    const cur = this.selectedCandidateIndex();
    const next = ((cur < 0 ? -1 : cur) + delta + list.length) % list.length;
    this.selectedCandidateIndex.set(next);
    const [x, y] = list[next];
    this.lockAt.emit({ x, y });
    return true;
  }

  private loadShowCandidates(): boolean {
    try { return localStorage.getItem('frameview.showCandidates') === '1'; }
    catch { return false; }
  }

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
