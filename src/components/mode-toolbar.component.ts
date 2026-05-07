import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PipelineState } from '../services/guider.store';
import { RETICLES, RETICLE_LABELS, ReticleStyle } from './reticle.component';

/**
 * Top toolbar — primary mode buttons + secondary actions + reticle picker.
 *
 * Mode buttons are the headline action: they're large, colour-coded by mode,
 * and the active one is filled. Acquire and Calibrate are common follow-ups
 * so they sit on the right of the toolbar.
 */
@Component({
  selector: 'app-mode-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="flex flex-wrap items-center gap-2 px-3 py-2 bg-zinc-950 border-b border-zinc-800">
      <span class="text-[11px] uppercase tracking-wider text-zinc-500 mr-1">mode</span>
      @for (m of modes; track m.value) {
        <button
          class="rounded px-3 py-1.5 text-xs font-medium border transition-colors"
          [class]="modeButtonClass(m.value)"
          (click)="modeRequested.emit(m.value)">
          {{ m.label }}
        </button>
      }

      <span class="ml-3 h-5 w-px bg-zinc-800"></span>

      <button
        class="rounded px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
        (click)="acquireRequested.emit()">
        re-acquire
      </button>

      <button
        class="rounded px-3 py-1.5 text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        [class]="dropEnabled() ? 'border-emerald-500 bg-emerald-700/80 hover:bg-emerald-600 text-emerald-50' : 'border-zinc-700 bg-zinc-900 text-zinc-400'"
        [disabled]="!dropEnabled()"
        [title]="dropEnabled() ? 'pull star into reticle (drop into fibre)' : 'requires guiding mode + active lock'"
        (click)="dropToReticleRequested.emit()">
        drop → reticle
      </button>

      <button
        class="rounded px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-50"
        [disabled]="true"
        title="calibration wizard — FL2.1">
        calibrate <span class="text-[10px] text-zinc-500">(soon)</span>
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
  `,
})
export class ModeToolbarComponent {
  state = input<PipelineState | undefined>(undefined);
  reticle = input.required<ReticleStyle>();

  modeRequested = output<string>();
  acquireRequested = output<void>();
  dropToReticleRequested = output<void>();
  reticleHomeRequested = output<void>();
  reticleChanged = output<ReticleStyle>();

  /** Server-side ``drop_to_reticle`` requires mode=guiding + acquired.
   *  Mirror the precondition client-side so the button is visibly
   *  disabled rather than firing an RPC that returns an error. */
  dropEnabled = computed(() => {
    const s = this.state();
    return !!s && s.mode === 'guiding' && s.acquired;
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
  readonly reticles = RETICLES;
  readonly labels = RETICLE_LABELS;

  private active = computed(() => this.state()?.mode);

  modeButtonClass(value: string): string {
    const isActive = this.active() === value;
    if (!isActive) return 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300';
    switch (value) {
      case 'off':         return 'border-zinc-500 bg-zinc-700 text-zinc-50';
      case 'monitoring':  return 'border-amber-500 bg-amber-700/80 text-amber-50';
      case 'guiding':     return 'border-emerald-500 bg-emerald-700/80 text-emerald-50';
      default:            return 'border-zinc-700 bg-zinc-800 text-zinc-100';
    }
  }
}
