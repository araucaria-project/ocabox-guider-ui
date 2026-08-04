import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PipelineState } from '../services/guider.store';
import { RETICLES, RETICLE_LABELS, ReticleStyle } from './reticle.component';

/**
 * Top toolbar — three rows, in operator-priority order:
 *
 *   row 1: method radio       — single | multi (soon) | fiber
 *   row 2: mode buttons       — off | monitoring | guiding   + re-acquire
 *   row 3: target actions     — drop → reticle | refine reticle | reticle picker + home
 *
 * Method is the topmost choice because it changes the meaning of every
 * other control below: in fiber mode there are no candidates, no
 * narrow-search box, and the diagnostics panel shows photocentroid
 * stats instead of star ADU. Mode is the second-level intent (off
 * for camera-idle, monitoring to observe drift without correcting,
 * guiding to actively pull). Target actions are routine click-fixers.
 */
@Component({
  selector: 'app-mode-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="px-3 py-2 bg-zinc-950 border-b border-zinc-800 space-y-1.5">

      <!-- ─── Row 1: method ─── -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11px] uppercase tracking-wider text-zinc-500 mr-1 w-12">method</span>
        @for (m of methods; track m.value) {
          <button
            class="rounded px-3 py-1.5 text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            [class]="methodButtonClass(m.value, m.disabled)"
            [disabled]="m.disabled"
            [title]="m.disabled ? m.tooltip : 'switch solver method to ' + m.label"
            (click)="!m.disabled && methodRequested.emit(m.value)">
            {{ m.label }}
            @if (m.disabled) { <span class="text-[10px] text-zinc-500 ml-1">(soon)</span> }
          </button>
        }
      </div>

      <!-- ─── Row 2: mode ─── -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11px] uppercase tracking-wider text-zinc-500 mr-1 w-12">mode</span>
        @for (m of modes; track m.value) {
          <button
            class="rounded px-3 py-1.5 text-xs font-medium border transition-colors"
            [class]="modeButtonClass(m.value)"
            (click)="modeRequested.emit(m.value)">
            {{ m.label }}
          </button>
        }
        <span class="ml-1 h-5 w-px bg-zinc-800"></span>
        <button
          class="rounded px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
          (click)="acquireRequested.emit()">
          re-acquire
        </button>
        <button
          class="rounded px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-50"
          [disabled]="true"
          title="calibration wizard — FL2.1">
          calibrate <span class="text-[10px] text-zinc-500">(soon)</span>
        </button>
      </div>

      <!-- ─── Row 3: target actions + reticle ─── -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11px] uppercase tracking-wider text-zinc-500 mr-1 w-12">target</span>
        <button
          class="rounded px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          [disabled]="!dropEnabled()"
          [title]="dropEnabled() ? 'pull the locked star onto the reticle — one-shot command' : 'requires guiding mode + active lock'"
          (click)="dropToReticleRequested.emit()">
          drop → reticle
        </button>
        <!-- Always rendered, enabled only while the server says the
             measurement is usable (hole_candidate.refinable). A
             control that vanishes teaches the operator nothing; a
             greyed one with the reason in its tooltip explains itself.
             The label carries the measured offset so the operator can
             judge the size of the move before committing it. -->
        <button
          class="rounded px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          [disabled]="!refineEnabled()"
          [title]="refineTitle()"
          (click)="refineEnabled() && refineReticleRequested.emit()">
          {{ refineLabel() }}
        </button>

        <span class="flex-1"></span>

        <label class="flex items-center gap-1.5 text-[11px] text-zinc-500">
          reticle
          <select
            class="rounded bg-zinc-900 border border-zinc-700 text-zinc-100 px-2 py-1 text-xs"
            [value]="reticle()"
            (change)="reticleChanged.emit($any($event.target).value)">
            @for (r of reticles; track r) {
              <option [value]="r" [selected]="r === reticle()">{{ labels[r] }}</option>
            }
          </select>
          <button
            class="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-100 px-2 py-1 text-[10px]"
            [disabled]="!homeEnabled()"
            [title]="homeEnabled() ? 'restore reticle to camera default position (h)' : 'no default reticle position configured'"
            (click)="reticleHomeRequested.emit()">
            home
          </button>
        </label>
      </div>
    </div>
  `,
})
export class ModeToolbarComponent {
  state = input<PipelineState | undefined>(undefined);
  reticle = input.required<ReticleStyle>();

  modeRequested = output<string>();
  methodRequested = output<string>();
  acquireRequested = output<void>();
  dropToReticleRequested = output<void>();
  refineReticleRequested = output<void>();
  reticleHomeRequested = output<void>();
  reticleChanged = output<ReticleStyle>();

  /** Server-side ``drop_to_reticle`` requires mode=guiding + acquired.
   *  Mirror the precondition client-side so the button is visibly
   *  disabled rather than firing an RPC that returns an error. */
  dropEnabled = computed(() => {
    const s = this.state();
    return !!s && s.mode === 'guiding' && s.acquired;
  });

  /** Latest measured reticle target from the state stream. ``null`` most
   *  of the time — the detector only reports when it has something. */
  private candidate = computed(() => this.state()?.hole_candidate ?? null);

  /** The action is offered exactly when the server says its own
   *  measurement is usable. Deliberately not second-guessed here: the
   *  server re-validates on the request, and duplicating its gate
   *  client-side would drift out of sync with the detector's tuning. */
  refineEnabled = computed(() => this.candidate()?.refinable === true);

  /** Label carries the measurement when there is one to act on, so the
   *  operator sees how far the reticle would move before clicking. */
  refineLabel = computed(() => {
    const c = this.candidate();
    const off = Number(c?.offset_px);
    return this.refineEnabled() && Number.isFinite(off)
      ? `refine reticle ${off.toFixed(1)} px`
      : 'refine reticle';
  });

  /** Tooltip is the server's own operator-facing ``reason`` whenever a
   *  measurement exists — usable or not, it is the honest explanation of
   *  what the detector currently sees. */
  refineTitle = computed(() => {
    const c = this.candidate();
    if (!c) return 'no reticle-target measurement — put a bright source on the reticle';
    return c.reason || 'measured reticle target available';
  });

  /** Reticle "home" only meaningful when the camera config provides a
   *  default position; without one the button is greyed out (no
   *  ambiguity vs falling back to e.g. sensor centre, which would
   *  pretend a default exists). */
  homeEnabled = computed(() => !!this.state()?.central_point_default);

  readonly modes = [
    { value: 'off', label: 'off' },
    { value: 'monitoring', label: 'monitoring' },
    { value: 'guiding', label: 'guiding' },
  ];
  /** Method selector. ``multi_star`` is parked — listed and styled like
   *  the others so the operator can see the shape of the feature, but
   *  disabled with a tooltip until the math + tests land. ``single_star``
   *  is the default everyday method; ``fiber_photocentroid`` is the
   *  spectrograph-feed mode that bypasses individual star detection. */
  readonly methods = [
    { value: 'single_star', label: 'single', disabled: false, tooltip: '' },
    { value: 'multi_star', label: 'multi', disabled: true,
      tooltip: 'multi-star solver — coming after FL2 first sky tuning' },
    { value: 'fiber_photocentroid', label: 'fiber', disabled: false, tooltip: '' },
  ];
  readonly reticles = RETICLES;
  readonly labels = RETICLE_LABELS;

  private activeMode = computed(() => this.state()?.mode);
  private activeMethod = computed(() => this.state()?.method);

  modeButtonClass(value: string): string {
    const isActive = this.activeMode() === value;
    if (!isActive) return 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300';
    switch (value) {
      case 'off':         return 'border-zinc-500 bg-zinc-700 text-zinc-50';
      case 'monitoring':  return 'border-amber-500 bg-amber-700/80 text-amber-50';
      case 'guiding':     return 'border-emerald-500 bg-emerald-700/80 text-emerald-50';
      default:            return 'border-zinc-700 bg-zinc-800 text-zinc-100';
    }
  }

  methodButtonClass(value: string, disabled: boolean): string {
    if (disabled) return 'border-zinc-800 bg-zinc-900 text-zinc-500';
    const isActive = this.activeMethod() === value;
    if (!isActive) return 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300';
    return 'border-sky-500 bg-sky-700/80 text-sky-50';
  }
}
