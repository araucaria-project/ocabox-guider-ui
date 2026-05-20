import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PipelineState } from '../services/guider.store';

type FiberOverride = {
  fiber_radius_px?: number;
  analysis_radius_px?: number;
  adu_sigma_threshold?: number;
  hole_zone_factor?: number;
  saturation_adu?: number;
};

/**
 * Fiber-photocentroid tuning panel. Mirrors CameraPanelComponent's
 * sparse-override pattern: displayed values track upstream until the
 * operator touches a slider, then that field is "dirty" until they
 * Apply (clears dirty) or Reset (discards local edits).
 *
 * Only meaningful when ``state.method === 'fiber_photocentroid'``; the
 * parent dashboard hides this panel otherwise. Tuning the knobs
 * dispatches a single ``set_state({method: 'fiber_photocentroid',
 * method_params: <merged>})`` so the server-side ``swap_method`` rebuilds
 * the method instance with the new values — same path the method-radio
 * uses.
 *
 * The 'why' of each knob is documented in the method's docstring
 * (``fiber_photocentroid.py``); tooltips here repeat the operational
 * summary so the operator can tune without leaving the UI.
 */
@Component({
  selector: 'app-fiber-config-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    @if (upstream(); as up) {
      <div class="space-y-3 text-xs">

        <div>
          <div class="flex items-baseline justify-between"
               title="Geometric fibre-hole radius. Dead zone — apparent offsets below this make no correction.">
            <span class="text-zinc-400">fiber r (px)</span>
            <span class="font-mono" [class.text-amber-300]="dirtyFiberR()">
              {{ valueFiberR() | number:'1.1-1' }}
            </span>
          </div>
          <input type="range" class="w-full accent-sky-500"
                 min="1" max="20" step="0.1"
                 [ngModel]="valueFiberR()"
                 (ngModelChange)="set('fiber_radius_px', $event)"/>
        </div>

        <div>
          <div class="flex items-baseline justify-between"
               title="Window half-size around reticle for photocentroid analysis. Typical 3× fiber_r.">
            <span class="text-zinc-400">analysis r (px)</span>
            <span class="font-mono" [class.text-amber-300]="dirtyAnalysisR()">
              {{ valueAnalysisR() | number:'1.1-1' }}
            </span>
          </div>
          <input type="range" class="w-full accent-sky-500"
                 min="5" max="40" step="0.5"
                 [ngModel]="valueAnalysisR()"
                 (ngModelChange)="set('analysis_radius_px', $event)"/>
        </div>

        <div>
          <div class="flex items-baseline justify-between"
               title="Tuning knob: ramp ends at fiber_r·factor. Lower = more aggressive (faster lock-on but overshoot risk). Higher = gentler (undershoot, slower convergence).">
            <span class="text-zinc-400">hole-zone factor</span>
            <span class="font-mono" [class.text-amber-300]="dirtyHoleFactor()">
              {{ valueHoleFactor() | number:'1.2-2' }}
            </span>
          </div>
          <input type="range" class="w-full accent-sky-500"
                 min="1.1" max="4.0" step="0.05"
                 [ngModel]="valueHoleFactor()"
                 (ngModelChange)="set('hole_zone_factor', $event)"/>
        </div>

        <div>
          <div class="flex items-baseline justify-between"
               title="Detection gate (σ above local background). Below this the method emits no correction (star in hole / not detectable).">
            <span class="text-zinc-400">ADU σ threshold</span>
            <span class="font-mono" [class.text-amber-300]="dirtyAduSigma()">
              {{ valueAduSigma() | number:'1.1-1' }}
            </span>
          </div>
          <input type="range" class="w-full accent-sky-500"
                 min="1.0" max="10.0" step="0.1"
                 [ngModel]="valueAduSigma()"
                 (ngModelChange)="set('adu_sigma_threshold', $event)"/>
        </div>

        <!-- Apply / Reset -->
        <div class="flex items-center gap-2 pt-1">
          <button
            class="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            [class]="hasDirty() ? 'bg-sky-600 hover:bg-sky-500 text-white' : 'bg-zinc-800 text-zinc-500'"
            [disabled]="!hasDirty()"
            (click)="apply()">
            apply
          </button>
          <button
            class="rounded px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50"
            [disabled]="!hasDirty()"
            (click)="reset()">
            reset
          </button>
          @if (rpcStatus(); as st) {
            <span class="text-[11px] ml-auto"
                  [class.text-emerald-400]="st.ok"
                  [class.text-red-400]="!st.ok">{{ st.message }}</span>
          }
        </div>

      </div>
    } @else {
      <div class="text-zinc-500 text-xs">waiting for state…</div>
    }
  `,
})
export class FiberConfigPanelComponent {
  state = input<PipelineState | undefined>(undefined);
  /** Emitted on Apply — full new method_params block (current params
   *  merged with overrides). Parent dispatches ``set_state`` with
   *  ``method`` and this payload so the swap path runs server-side. */
  applyParams = output<Record<string, number>>();

  rpcStatus = signal<{ ok: boolean; message: string } | null>(null);
  private overrides = signal<FiberOverride>({});

  upstream = computed<Required<FiberOverride> | null>(() => {
    const s = this.state();
    if (!s || s.method !== 'fiber_photocentroid') return null;
    const mp = s.method_params ?? {};
    const num = (k: string, def: number) => {
      const v = Number(mp[k]);
      return Number.isFinite(v) ? v : def;
    };
    return {
      fiber_radius_px: num('fiber_radius_px', 5),
      analysis_radius_px: num('analysis_radius_px', 15),
      adu_sigma_threshold: num('adu_sigma_threshold', 3),
      hole_zone_factor: num('hole_zone_factor', 2),
      saturation_adu: num('saturation_adu', 62000),
    };
  });

  valueFiberR = computed(() => {
    const o = this.overrides();
    return o.fiber_radius_px ?? this.upstream()?.fiber_radius_px ?? 5;
  });
  valueAnalysisR = computed(() => {
    const o = this.overrides();
    return o.analysis_radius_px ?? this.upstream()?.analysis_radius_px ?? 15;
  });
  valueHoleFactor = computed(() => {
    const o = this.overrides();
    return o.hole_zone_factor ?? this.upstream()?.hole_zone_factor ?? 2;
  });
  valueAduSigma = computed(() => {
    const o = this.overrides();
    return o.adu_sigma_threshold ?? this.upstream()?.adu_sigma_threshold ?? 3;
  });

  dirtyFiberR = computed(() => 'fiber_radius_px' in this.overrides());
  dirtyAnalysisR = computed(() => 'analysis_radius_px' in this.overrides());
  dirtyHoleFactor = computed(() => 'hole_zone_factor' in this.overrides());
  dirtyAduSigma = computed(() => 'adu_sigma_threshold' in this.overrides());
  hasDirty = computed(() => Object.keys(this.overrides()).length > 0);

  set(field: keyof FiberOverride, value: number): void {
    this.overrides.update(o => ({ ...o, [field]: value }));
    this.rpcStatus.set(null);
  }

  apply(): void {
    const up = this.upstream();
    if (!up) return;
    const merged: Record<string, number> = { ...up, ...this.overrides() };
    this.applyParams.emit(merged);
  }

  reset(): void {
    this.overrides.set({});
    this.rpcStatus.set(null);
  }

  reportRpc(ok: boolean, message: string): void {
    this.rpcStatus.set({ ok, message });
    if (ok) this.overrides.set({});
  }
}
