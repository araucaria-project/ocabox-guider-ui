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
 *  → "2m 14s". Always two decimals in "s" range so the field width
 *  stays constant (no "12 s" → "9.3 s" reflow). Pair with
 *  ``tabular-nums`` + ``min-w-[Nch]`` on the host span. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${String(r).padStart(2, '0')}s`;
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
      <!-- Pan/zoom wrapper. Holds both image and SVG so they stay
           aligned. NOTE: click→sensor mapping must NOT rely on
           getScreenCTM() — Gecko ignores ancestor CSS transforms in it
           (see svgPoint()); we derive coordinates from
           getBoundingClientRect() instead. -->
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
             with the image-lag indicator. Fixed-width columns
             (tabular-nums + min-w-Nch) keep the line from reflowing
             as digit values change. -->
        @if (latestMeta(); as lm) {
          <div class="absolute top-1 left-1 px-1.5 py-0.5 text-[10px]
                      font-mono tabular-nums leading-tight text-zinc-100
                      bg-black/55 rounded pointer-events-none whitespace-nowrap">
            <!-- Flex + gap-x gives reliable inter-column spacing
                 regardless of how Tailwind shakes out inline-block
                 widths. Each cell gets min-width so as digit counts
                 grow the columns don't pack together; tabular-nums
                 stops single-digit jitter inside each cell. -->
            <div class="flex gap-x-3" [class.text-amber-300]="lm.ageStale">
              <span>{{ lm.utc }}</span>
              <span class="min-w-[5ch] text-right">{{ lm.ageStr }}</span>
              <span class="min-w-[5ch] text-right">#{{ lm.seq }}</span>
              <span>exp <span class="inline-block min-w-[5ch] text-right">{{ lm.expStr }}</span></span>
            </div>
            @if (imageLag(); as lag) {
              <div class="flex gap-x-3 text-amber-300">
                <span>↻ showing</span>
                <span class="min-w-[5ch] text-right">#{{ lag.shownSeq }}</span>
                <span><span class="inline-block min-w-[5ch] text-right">{{ lag.gapStr }}</span> behind</span>
              </div>
            }
          </div>
        }

        <!-- Phase pill in top-right. Suppressed in TRACKING (normal
             operation — overlay clutter to display the obvious).
             Visible during pulse lifecycle so the operator sees which
             stage the pipeline is in: PULSING (mount moving),
             SETTLING (damping), ACQUIRING (looking for re-lock). -->
        <!-- Phase pill — bottom-centre. Top-right is reserved for
             control toggles (view-stars etc.); the pill there
             overlapped them visually. Bottom-centre is also a more
             natural "what's the system doing right now" location,
             above the scale bar. -->
        @if (phaseLabel(); as p) {
          <div class="absolute bottom-1 left-1/2 -translate-x-1/2
                      px-2 py-0.5 text-[10px]
                      font-mono uppercase tracking-wider rounded
                      pointer-events-none"
               [class.bg-amber-500]="p === 'PULSING'"
               [class.bg-amber-600]="p === 'SETTLING'"
               [class.bg-emerald-600]="p === 'ACQUIRING'"
               [class.text-zinc-900]="p === 'PULSING'"
               [class.text-zinc-50]="p === 'SETTLING' || p === 'ACQUIRING'">
            {{ p }}
          </div>
        }

        <!-- Transient notice: click rejections (wide-search guard) and
             target-command outcomes (refine reticle). One surface, two
             tones — red for refusals, emerald for "it happened". -->
        @if (clickNotice(); as msg) {
          <div class="absolute bottom-7 left-1/2 -translate-x-1/2 max-w-[80%]
                      px-2 py-1 text-[11px] rounded border
                      pointer-events-none text-center"
               [class]="noticeKind() === 'ok'
                        ? 'bg-emerald-950/90 text-emerald-200 border-emerald-700/60'
                        : 'bg-red-950/90 text-red-200 border-red-700/60'">
            {{ msg }}
          </div>
        }

        <!-- Method badge — visible only when fiber mode is active so
             the operator never confuses what they're seeing (no
             candidate circles, no narrow box, sky ring of the reticle
             radius at the centre means fiber). single_star is the
             default and needs no label. -->
        @if (isFiberMode()) {
          <div class="absolute bottom-1 right-2 px-2 py-0.5 text-[10px]
                      font-mono uppercase tracking-wider rounded
                      bg-sky-700 text-sky-50 pointer-events-none">
            fiber
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
                 the list in rank order. Suppressed in fiber mode —
                 fiber doesn't run star detection at all, so there are
                 no candidates and the overlay would be empty or stale. -->
            @if (!isFiberMode() && showCandidates() && s.candidates && s.candidates.length > 0) {
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

            <!-- Search circle = wide_search_radius_px around central_point.
                 Hidden in fiber mode — fiber doesn't do wide search,
                 the dashed circle just adds visual noise around the
                 reticle. -->
            @if (!isFiberMode()) {
              <circle
                [attr.cx]="s.central_point[0]"
                [attr.cy]="s.central_point[1]"
                [attr.r]="s.wide_search_radius_px"
                fill="none"
                [attr.stroke]="wideBlink() ? 'rgba(248, 113, 113, 0.95)' : 'rgba(125, 211, 252, 0.5)'"
                [attr.stroke-width]="overlayStrokePx() * (wideBlink() ? 1.8 : 1)"
                vector-effect="non-scaling-stroke"
                stroke-dasharray="14,8"
                pointer-events="none"
              />
            }

            <!-- Reticle radius marker — outline-only ring of radius
                 'fiber_radius_px' at 'central_point'. Marks the
                 light-absorbing target (for BESO: the spectrograph
                 fibre entrance) so the operator sees where light gets
                 coupled away from the detector. It used to be a filled
                 semi-transparent disc, which hid exactly the pixels
                 the operator has to judge — the entrance itself is
                 visible as a dark disk inside the halo (confirmed on
                 the 2026-08-03 screenshots), and a fill over it makes
                 that unreadable. The analysis window (used by the
                 photocentroid method) extends to 'analysis_radius_px',
                 drawn as a thin sky-blue ring so the operator can see
                 the still-being-measured region. -->
            @if (isFiberMode()) {
              <circle
                [attr.cx]="s.central_point[0]"
                [attr.cy]="s.central_point[1]"
                [attr.r]="fiberRadiusPx()"
                fill="none"
                stroke="rgba(56, 189, 248, 0.9)"
                [attr.stroke-width]="overlayStrokePx()"
                vector-effect="non-scaling-stroke"
                pointer-events="none"
              />
              <circle
                [attr.cx]="s.central_point[0]"
                [attr.cy]="s.central_point[1]"
                [attr.r]="analysisRadiusPx()"
                fill="none"
                stroke="rgba(125, 211, 252, 0.35)"
                [attr.stroke-width]="overlayStrokePx() * 0.6"
                stroke-dasharray="6,4"
                vector-effect="non-scaling-stroke"
                pointer-events="none"
              />
            }

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

            <!-- Guide anchor (where guiding holds the star) — amber
                 broken X, labelled. Drawn only when it carries
                 information: guiding mode AND anchor meaningfully away
                 from the reticle. After drop→reticle (and in fiber,
                 where the target is definitionally the reticle) the X
                 would sit exactly on the reticle and only confuse —
                 there the green target line (below) takes over as the
                 "guiding to reticle" cue. Field lesson 2026-07-29: an
                 unlabelled always-on amber cross was read as noise. -->
            @if (s.guide_anchor && s.mode === 'guiding' && anchorOffReticle()) {
              <g
                [attr.transform]="'translate(' + s.guide_anchor[0] + ',' + s.guide_anchor[1] + ')'"
                pointer-events="none"
              >
                <text
                  x="14" y="14"
                  fill="rgba(251, 191, 36, 0.85)"
                  [attr.font-size]="overlayLabelPx()"
                  font-family="ui-monospace, monospace"
                >anchor</text>
                <!-- Broken X: 4 short segments with a gap at the centre
                     so the pixel under the anchor (= the reticle at
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

              <!-- Target line: acquired → the position guiding is
                   actually pulling toward (anchor, or reticle when
                   anchor==reticle). Drawn ONLY in guiding and only
                   while there is real separation — in monitoring, or
                   when merely holding position (anchor==star), a line
                   to the reticle would falsely announce "moving the
                   star to centre" (2026-07-29 misreading). -->
              @if (s.mode === 'guiding' && guideTarget(); as tgt) {
                <line
                  [attr.x1]="tgt[0]"
                  [attr.y1]="tgt[1]"
                  [attr.x2]="s.acquired_pos[0]"
                  [attr.y2]="s.acquired_pos[1]"
                  stroke="rgba(52, 211, 153, 0.45)"
                  [attr.stroke-width]="overlayStrokePx() * 0.9"
                  vector-effect="non-scaling-stroke"
                  pointer-events="none"
                />
              }
            }

            <!-- Search-region box. In TRACKING (no pulse) it sits at
                 acquired_pos for narrow re-acquisition. During
                 ACQUIRING (post-settle, pulse complete) it moves to
                 active_pulse.predicted_pos — the operator sees the
                 box jump to where the solver is *now* looking for the
                 star, not where it was when the pulse fired. Skipped
                 entirely during IN_FLIGHT / SETTLING — the trajectory
                 arrow below is the right visualisation then. Also
                 skipped in fiber mode (no narrow-search step). -->
            @if (!isFiberMode() && s.acquired && s.acquired_pos
                 && s.frame_phase !== 'in_flight'
                 && s.frame_phase !== 'settling') {
              <rect
                [attr.x]="(s.active_pulse?.predicted_pos?.[0] ?? s.acquired_pos[0]) - s.search_reg_px / 2"
                [attr.y]="(s.active_pulse?.predicted_pos?.[1] ?? s.acquired_pos[1]) - s.search_reg_px / 2"
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

            <!-- Trajectory arrow during IN_FLIGHT and SETTLING. The
                 operator sees an explicit "star is moving from here to
                 here" line so the smeared frames don't read as
                 "guider broke". Stroke amber to distinguish from the
                 stable green/cyan overlays. -->
            @if (s.active_pulse
                 && (s.frame_phase === 'in_flight' || s.frame_phase === 'settling')) {
              <g pointer-events="none">
                <line
                  [attr.x1]="s.active_pulse.src_pos[0]"
                  [attr.y1]="s.active_pulse.src_pos[1]"
                  [attr.x2]="s.active_pulse.predicted_pos[0]"
                  [attr.y2]="s.active_pulse.predicted_pos[1]"
                  stroke="rgba(251, 191, 36, 0.85)"
                  [attr.stroke-width]="overlayStrokePx() * 1.4"
                  vector-effect="non-scaling-stroke"
                />
                <!-- Endpoint markers — small circle at source, larger
                     amber ring at predicted target. -->
                <circle
                  [attr.cx]="s.active_pulse.src_pos[0]"
                  [attr.cy]="s.active_pulse.src_pos[1]"
                  [attr.r]="overlayMarkerPx() * 0.35"
                  fill="rgba(251, 191, 36, 0.6)"
                  stroke="none"
                />
                <circle
                  [attr.cx]="s.active_pulse.predicted_pos[0]"
                  [attr.cy]="s.active_pulse.predicted_pos[1]"
                  [attr.r]="overlayMarkerPx() * 0.55"
                  fill="none"
                  stroke="rgba(251, 191, 36, 0.85)"
                  [attr.stroke-width]="overlayStrokePx() * 1.2"
                  vector-effect="non-scaling-stroke"
                />
              </g>
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
          [disabled]="isFiberMode()"
          [class]="showCandidates() && !isFiberMode() ? 'bg-amber-700/80 hover:bg-amber-700 text-amber-50' : 'bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200'"
          [title]="isFiberMode() ? 'fiber method has no candidates — toggle disabled' : showCandidates() ? 'hide detection circles (currently shown — TAB cycles lock)' : 'show all detection candidates as circles (TAB cycles lock through them)'"
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
        <div class="h-1"></div>
        <button
          type="button"
          (click)="toggleInset()"
          [class]="showInset() ? 'bg-sky-700/80 hover:bg-sky-700 text-sky-50' : 'bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200'"
          [title]="showInset() ? 'hide reticle magnifier' : 'show reticle magnifier (close-up around the reticle)'"
          class="w-7 h-7 rounded grid place-items-center"
        >
          <!-- reticle-magnifier icon: framed square + crosshair dot -->
          <svg viewBox="0 0 16 16" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <rect x="2" y="2" width="12" height="12" rx="1.5"/>
            <line x1="8" y1="5.5" x2="8" y2="10.5"/>
            <line x1="5.5" y1="8" x2="10.5" y2="8"/>
          </svg>
        </button>
      </div>

      <!-- Zoom indicator: only shown while zoomed. -->
      @if (view().zoom !== 1) {
        <div class="absolute top-1 left-1 text-[10px] font-mono text-zinc-200 bg-black/50 px-1.5 py-0.5 rounded z-10 pointer-events-none">
          {{ zoomLabel() }}
        </div>
      }

      <!-- Reticle magnifier — HARPS-N-inspired inset showing a
           close-up around the reticle so the operator can see
           sub-pixel detail at the target position. Method-independent
           tool (toggle button in the zoom stack): observers use it as
           a viewfinder during manual work as much as during fiber
           guiding. Auto-enables the first time fiber mode activates
           if the operator never touched the toggle (fiber work
           without the close-up is flying blind). Method-specific
           overlays inside are gated separately. Same image URL as
           the main view — browser serves it from cache, no extra
           fetch. -->
      @if (showInset() && displayedUrl(); as url) {
        <div class="absolute bottom-12 left-1 z-10 pointer-events-none">
          <div class="rounded border border-sky-600/70 bg-black/80 overflow-hidden"
               style="width: 160px; height: 160px;">
            <svg
              [attr.viewBox]="subrasterViewBox()"
              preserveAspectRatio="xMidYMid meet"
              class="w-full h-full">
              <image
                [attr.href]="url"
                x="0" y="0"
                [attr.width]="sensorWidth()"
                [attr.height]="sensorHeight()"
                preserveAspectRatio="none"
              />
              <!-- Repeat the key overlays inside the inset so the
                   operator can read photocentroid position vs reticle
                   at the magnified scale. -->
              @if (state(); as s) {
                <!-- Fiber-method overlays only: reticle-radius ring +
                     analysis ring visualise fiber_photocentroid
                     parameters and mean nothing in other methods.
                     Outline-only, never filled: this inset exists so
                     the operator can read the dark entrance disk in the
                     halo, and a fill would cover the one thing they
                     came here to see. -->
                @if (isFiberMode()) {
                  <circle
                    [attr.cx]="s.central_point[0]"
                    [attr.cy]="s.central_point[1]"
                    [attr.r]="fiberRadiusPx()"
                    fill="none"
                    stroke="rgba(56, 189, 248, 0.9)"
                    stroke-width="0.5"
                    vector-effect="non-scaling-stroke"/>
                  <circle
                    [attr.cx]="s.central_point[0]"
                    [attr.cy]="s.central_point[1]"
                    [attr.r]="analysisRadiusPx()"
                    fill="none"
                    stroke="rgba(125, 211, 252, 0.45)"
                    stroke-width="0.5"
                    stroke-dasharray="2,1.5"
                    vector-effect="non-scaling-stroke"/>
                }
                <!-- Reticle crosshair (tiny so it doesn't obscure the
                     pixels at the target). -->
                <line
                  [attr.x1]="s.central_point[0] - 2"
                  [attr.x2]="s.central_point[0] + 2"
                  [attr.y1]="s.central_point[1]"
                  [attr.y2]="s.central_point[1]"
                  stroke="rgba(125, 211, 252, 0.9)"
                  stroke-width="0.6"
                  vector-effect="non-scaling-stroke"/>
                <line
                  [attr.x1]="s.central_point[0]"
                  [attr.x2]="s.central_point[0]"
                  [attr.y1]="s.central_point[1] - 2"
                  [attr.y2]="s.central_point[1] + 2"
                  stroke="rgba(125, 211, 252, 0.9)"
                  stroke-width="0.6"
                  vector-effect="non-scaling-stroke"/>
                <!-- Measured reticle target — where the server's
                     detector says the absorbing feature actually is.
                     Amber dashed ring of the detector's own radius, so
                     the gap between it and the cyan reticle cross *is*
                     the offset the refine action would remove. Drawn
                     only here: the whole judgement happens at this
                     magnification, and the main view must not gain
                     permanent chrome for a field that is null most of
                     the time. -->
                @if (s.hole_candidate; as hc) {
                  <circle
                    [attr.cx]="hc.x"
                    [attr.cy]="hc.y"
                    [attr.r]="holeMarkerRadiusPx()"
                    fill="none"
                    stroke="rgba(251, 191, 36, 0.95)"
                    stroke-width="0.5"
                    stroke-dasharray="1.5,1.2"
                    vector-effect="non-scaling-stroke"/>
                  <circle
                    [attr.cx]="hc.x"
                    [attr.cy]="hc.y"
                    r="0.4"
                    fill="rgba(251, 191, 36, 0.95)"
                    stroke="none"/>
                }
                <!-- Acquired-position marker (photocentroid in fiber
                     mode, locked star otherwise). -->
                @if (s.acquired && s.acquired_pos) {
                  <circle
                    [attr.cx]="s.acquired_pos[0]"
                    [attr.cy]="s.acquired_pos[1]"
                    r="1.5"
                    fill="rgba(52, 211, 153, 0.95)"
                    stroke="rgba(16, 185, 129, 1.0)"
                    stroke-width="0.4"
                    vector-effect="non-scaling-stroke"/>
                }
              }
            </svg>
          </div>
          <!-- Tiny scale label below the inset, plus a one-line legend
               for the measured-target ring while one exists (it is null
               most of the time, so this costs no permanent space). -->
          <div class="mt-0.5 text-[9px] font-mono text-sky-300/70 text-center">
            ±{{ subrasterHalfPx() | number:'1.0-0' }} px
          </div>
          @if (state()?.hole_candidate) {
            <div class="text-[9px] font-mono text-amber-300/80 text-center">
              ◌ measured reticle target
            </div>
          }
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
  /** Caller-supplied sensor extent override. Normally we derive from
   *  the latest thumbnail notification's ``dimensions`` field — that's
   *  authoritative because the camera+protocol stack reports the
   *  actual frame shape after binning/transpose. The inputs exist for
   *  the rare case where a parent already knows the geometry before
   *  the first thumbnail arrives. ``null`` means "use discovery". */
  sensorWidthInput = input<number | null>(null, { alias: 'sensorWidth' });
  sensorHeightInput = input<number | null>(null, { alias: 'sensorHeight' });

  /** Effective sensor dimensions: thumbnail-derived first, then
   *  explicit input override, then BESO defaults. The defaults remain
   *  so the SVG has something to draw before the first thumbnail
   *  lands (otherwise the viewBox would be 0×0 and the reticle would
   *  flash off-screen during page load). */
  sensorWidth = computed(() => {
    const dim = this.latestNote()?.dimensions;
    if (Array.isArray(dim) && dim[0] > 0) return Number(dim[0]);
    return this.sensorWidthInput() ?? 1936;
  });
  sensorHeight = computed(() => {
    const dim = this.latestNote()?.dimensions;
    if (Array.isArray(dim) && dim[1] > 0) return Number(dim[1]);
    return this.sensorHeightInput() ?? 1216;
  });
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

  /** Reticle-magnifier inset toggle — method-independent (toggle
   *  button in the zoom stack). Persisted; additionally auto-enabled
   *  the first time fiber mode activates if the operator never
   *  touched the toggle (see constructor), preserving the previous
   *  fiber workflow where the inset appeared automatically. */
  showInset = signal<boolean>(this.loadShowInset());

  /** True when guide_anchor sits meaningfully away from the reticle —
   *  gates the amber anchor X (an X exactly on the reticle carries no
   *  information; see template note). */
  anchorOffReticle = computed<boolean>(() => {
    const s = this.state();
    const a = s?.guide_anchor, c = s?.central_point;
    if (!a || !c) return false;
    return Math.hypot(a[0] - c[0], a[1] - c[1]) > 1.0;
  });

  /** The position guiding is actually pulling the star toward —
   *  anchor when set, else the reticle. Null unless there is real
   *  separation from the acquired position (a zero-length target line
   *  is visual noise; "holding in place" honestly draws nothing). */
  guideTarget = computed<[number, number] | null>(() => {
    const s = this.state();
    if (!s?.acquired || !s.acquired_pos) return null;
    const tgt = s.guide_anchor ?? s.central_point;
    if (!tgt) return null;
    const d = Math.hypot(tgt[0] - s.acquired_pos[0], tgt[1] - s.acquired_pos[1]);
    return d > 1.0 ? [tgt[0], tgt[1]] : null;
  });

  /** Wide-search click guard state: brief red blink of the circle +
   *  transient notice when a click is rejected (outside the circle, or
   *  a selection click in fiber mode). Local mini-notice — no global
   *  toast infrastructure exists yet by design. Also carries outcomes
   *  of target commands issued from the toolbar (refine reticle), so
   *  operator feedback lands where the operator is looking. */
  wideBlink = signal<boolean>(false);
  clickNotice = signal<string | null>(null);
  noticeKind = signal<'error' | 'ok'>('error');
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Show a transient notice over the frame. ``kind`` selects the tone
   *  (refusal vs confirmation); the message auto-clears. Public so the
   *  parent dashboard can report target-command outcomes through the
   *  same surface as the click guard. */
  showNotice(message: string, kind: 'error' | 'ok' = 'error'): void {
    this.noticeKind.set(kind);
    this.clickNotice.set(message);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.clickNotice.set(null), 3500);
  }

  private rejectClick(message: string, blink: boolean): void {
    if (blink) {
      this.wideBlink.set(true);
      setTimeout(() => this.wideBlink.set(false), 900);
    }
    this.showNotice(message, 'error');
  }

  readonly ZOOM_MIN = ZOOM_MIN;
  readonly ZOOM_MAX = ZOOM_MAX;

  private host = viewChild<ElementRef<HTMLElement>>('host');

  /** Load-serialising image swap. Slow links (VPN) can't pull a
   *  notification's JPEG before the next one arrives; naively binding
   *  ``<img [src]>`` to the latest URL aborts the in-flight fetch
   *  each time, so the browser never finishes any image and the
   *  displayed frame freezes — while the metadata races ahead.
   *
   *  State machine:
   *  - ``displayedNote`` = what the ``<img>`` element is bound to.
   *  - ``imageLoading`` = a fetch is in progress (set true when we
   *    point ``<img src>`` at a new URL, cleared by ``(load)`` /
   *    ``(error)``).
   *  - When ``latestNote`` changes AND we're not loading AND latest
   *    differs from displayed → adopt the latest into ``displayedNote``
   *    (single effect below). That changes the URL, browser fetches,
   *    ``(load)`` fires when done. We *don't* advance from inside
   *    ``onImageLoad`` because if the URL happens to match what was
   *    already there (same note adopted again, or the fallback path),
   *    no new fetch fires and the chain would stall. Driving advance
   *    from the latestNote-signal closure is robust against that. */
  private displayedNote = signal<ThumbnailNotification | null>(null);
  private latestNote = computed<ThumbnailNotification | null>(() =>
    this.store.thumbnails().get(this.instance()) ?? null,
  );
  private imageLoading = signal<boolean>(false);

  displayedUrl = computed<string | null>(() => {
    const note = this.displayedNote();
    return note ? this.store.resolveThumbnailUrl(note.path) : null;
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

  /** Human-readable phase pill label. Returns null in TRACKING so the
   *  overlay disappears in normal operation. PULSING covers the
   *  mount-in-motion window; SETTLING the damping window; ACQUIRING
   *  the post-settle re-lock window. */
  phaseLabel = computed<'PULSING' | 'SETTLING' | 'ACQUIRING' | null>(() => {
    const s = this.state();
    if (!s) return null;
    switch (s.frame_phase) {
      case 'in_flight': return 'PULSING';
      case 'settling': return 'SETTLING';
      case 'acquiring': return 'ACQUIRING';
      default: return null;
    }
  });

  /** Fiber mode is active when the solver method is
   *  ``fiber_photocentroid``. Flips the overlay set: candidate circles,
   *  search-radius circle and narrow-search box go away; filled
   *  fiber-hole disc + analysis-window ring + FIBER badge appear. */
  isFiberMode = computed<boolean>(() => {
    return this.state()?.method === 'fiber_photocentroid';
  });

  /** Fiber-hole radius (pixels) sourced from the active method's
   *  ``method_params.fiber_radius_px``. Falls back to a sensible
   *  default if the field is missing (e.g. legacy state cache before
   *  first state push). Same fallback strategy for the analysis
   *  window radius below. */
  fiberRadiusPx = computed<number>(() => {
    const mp = this.state()?.method_params;
    const v = Number(mp?.['fiber_radius_px']);
    return Number.isFinite(v) && v > 0 ? v : 5;
  });

  analysisRadiusPx = computed<number>(() => {
    const mp = this.state()?.method_params;
    const v = Number(mp?.['analysis_radius_px']);
    return Number.isFinite(v) && v > 0 ? v : 15;
  });

  /** Radius (sensor px) of the measured-reticle-target marker. The
   *  detector's own ``hole_detect.radius_px`` is authoritative — it is
   *  what was matched against the image; ``fiber_radius_px`` is the
   *  solver's view of the same feature and only a fallback for services
   *  that don't publish the detector config. */
  holeMarkerRadiusPx = computed<number>(() => {
    const v = Number(this.state()?.hole_detect?.radius_px);
    return Number.isFinite(v) && v > 0 ? v : this.fiberRadiusPx();
  });

  /** Subraster (magnifier inset) half-size in sensor pixels — set
   *  to 1.5× the analysis radius so the operator sees a bit of
   *  context around the analysis window. Clamped so the inset doesn't
   *  pretend to show more than the camera produces. */
  subrasterHalfPx = computed<number>(() => {
    const r = this.analysisRadiusPx();
    return Math.max(8, Math.min(60, Math.round(r * 1.5)));
  });

  /** viewBox string for the subraster SVG — centred on central_point
   *  with the half-size from above. Falls back to the sensor centre
   *  if central_point isn't set yet (early bootstrap before the first
   *  state push). */
  subrasterViewBox = computed<string>(() => {
    const s = this.state();
    const cx = s?.central_point?.[0] ?? this.sensorWidth() / 2;
    const cy = s?.central_point?.[1] ?? this.sensorHeight() / 2;
    const r = this.subrasterHalfPx();
    return `${cx - r} ${cy - r} ${2 * r} ${2 * r}`;
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

  /** Browser finished loading the current image. Clear the loading
   *  flag — that re-arms the advancement effect, which will pick up
   *  the latest note (possibly multiple frames newer by now) and
   *  start the next fetch. Skipping intermediates on a slow link is
   *  desirable: we don't owe the operator every frame, just the
   *  freshest one we can sustain. */
  onImageLoad(): void {
    this.imageLoading.set(false);
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
    // Reticle-magnifier migration: before the toggle existed the inset
    // appeared automatically with fiber mode. Preserve that habit for
    // operators who never touched the new toggle — first fiber
    // activation switches it on (once per page-load; the operator's
    // explicit toggle always wins afterwards).
    effect(() => {
      if (this.isFiberMode() && !this.showInset() && !this.insetTouched()) {
        this.showInset.set(true);
      }
    }, { allowSignalWrites: true });

    // Live age ticker — drives the frame-meta overlay's age readout
    // without waiting for a new thumbnail notification. 1 Hz is plenty
    // (operator's eye doesn't resolve faster than that for a ms-level
    // counter) and stays well under any plausible polling concern.
    const ticker = setInterval(() => this.nowTick.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(ticker));

    // Image-advance pump. Fires whenever ``latestNote`` changes (new
    // notification) OR ``imageLoading`` flips back to false (current
    // load finished). Adopts the freshest note iff no fetch is in
    // progress and the latest actually differs from what's displayed.
    // Covers both bootstrap (displayed=null) and steady-state
    // advancement on a slow link. Earlier version advanced from
    // ``onImageLoad``, which silently stalled when the URL happened
    // to match what was already there (no new fetch → no new load
    // event → no further advancement). Driving from the signal
    // closure is robust against that.
    effect(() => {
      const latest = this.latestNote();
      if (!latest) return;
      if (this.imageLoading()) return;
      if (latest === this.displayedNote()) return;
      this.imageLoading.set(true);
      this.displayedNote.set(latest);
    }, { allowSignalWrites: true });

  }

  onSvgClick(ev: MouseEvent): void {
    const pt = this.svgPoint(ev);
    if (!pt) return;
    // Client-side selection guard. The server accepts any lock_at and
    // returns ok — the failure used to be silent and downstream (narrow
    // miss → wide re-acquire snapping back inside the circle), which
    // read as "clicking does nothing" (2026-07-29). Reject up front
    // with visible feedback instead.
    const s = this.state();
    if (this.isFiberMode()) {
      this.rejectClick('fiber method has no star selection — the reticle is the target', false);
      return;
    }
    const c = s?.central_point;
    const r = s?.wide_search_radius_px;
    if (c && r && Math.hypot(pt[0] - c[0], pt[1] - c[1]) > r) {
      this.rejectClick(
        'outside the wide-search circle — selection works only inside it '
        + '(enlarge with the wide-search-r slider, or bring the star in)',
        true,
      );
      return;
    }
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

  toggleInset(): void {
    const next = !this.showInset();
    this.showInset.set(next);
    try {
      localStorage.setItem('frameview.showInset', next ? '1' : '0');
      localStorage.setItem('frameview.insetTouched', '1');
    } catch { /* ignore */ }
  }

  private loadShowInset(): boolean {
    try { return localStorage.getItem('frameview.showInset') === '1'; }
    catch { return false; }
  }

  private insetTouched(): boolean {
    try { return localStorage.getItem('frameview.insetTouched') === '1'; }
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
    // Screen → sensor conversion WITHOUT getScreenCTM(): Gecko does not
    // compose CSS transforms of HTML ancestors into the CTM (bugzilla
    // #1610093), so under our wrapper-div `translate(pan) scale(zoom)`
    // Firefox mapped clicks as if zoom = 1 — the right-click reticle
    // "ran away" under zoom (masked on left-click by the solver's
    // narrow-search snap). getBoundingClientRect() reflects the full
    // transform chain in every engine; the viewBox mapping
    // (`preserveAspectRatio="xMidYMid meet"` = uniform scale, centred
    // letterbox) is reproduced explicitly below. Uniformity of the
    // zoom means the letterbox math is identical on the scaled rect,
    // and pan is absorbed by rect.left/top.
    const rect = svg.getBoundingClientRect();
    const vbW = this.sensorWidth();
    const vbH = this.sensorHeight();
    if (!vbW || !vbH || rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / vbW, rect.height / vbH);
    const offX = rect.left + (rect.width - vbW * scale) / 2;
    const offY = rect.top + (rect.height - vbH * scale) / 2;
    return [(ev.clientX - offX) / scale, (ev.clientY - offY) / scale];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
