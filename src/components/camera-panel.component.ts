import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PipelineState } from '../services/guider.store';

type EditableFields = 'exp_time' | 'gain' | 'binning' | 'wide_search_radius_px';
type Snapshot = {
  exp_time: number;
  gain: number | null;
  binning: number;
  wide_search_radius_px: number;
};

/**
 * Camera-side controls.
 *
 * The data model is sparse-overrides over upstream:
 *
 *   upstream = pure derivation of the current pipeline state input
 *   overrides = local map of fields the operator has touched
 *   value(field) = field in overrides ? overrides[field] : upstream[field]
 *
 * No effects, no signal writes-from-reads, no feedback loops. State
 * arriving from the server simply changes `upstream`; if a field is in
 * overrides it stays edited, otherwise the displayed value tracks
 * upstream automatically. `Apply` emits the override map as a patch and
 * clears overrides on success.
 */
@Component({
  selector: 'app-camera-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    @if (upstream(); as up) {
      <div class="space-y-3 text-xs">

        <!-- ─── Exposure ─── -->
        <div>
          <div class="flex items-baseline justify-between">
            <span class="text-zinc-400">exposure</span>
            <span class="font-mono"
                  [class.text-amber-300]="dirtyExpTime()">
              {{ valueExpTime() | number:'1.2-2' }}s
            </span>
          </div>
          <input type="range" class="w-full accent-emerald-500"
                 min="0.05" max="10" step="0.05"
                 [ngModel]="valueExpTime()"
                 (ngModelChange)="set('exp_time', $event)"/>
          <div class="flex gap-1 mt-1">
            @for (preset of expPresets; track preset) {
              <button class="rounded bg-zinc-800 hover:bg-zinc-700 px-1.5 py-0.5 text-[10px]"
                      (click)="set('exp_time', preset)">{{ preset }}s</button>
            }
          </div>
        </div>

        <!-- ─── Gain ─── -->
        <div>
          <div class="flex items-baseline justify-between">
            <span class="text-zinc-400">gain</span>
            <span class="font-mono" [class.text-amber-300]="dirtyGain()">
              {{ valueGain() ?? '—' }}
            </span>
          </div>
          <input type="range" class="w-full accent-emerald-500"
                 min="0" max="300" step="1"
                 [ngModel]="valueGain() ?? 0"
                 (ngModelChange)="set('gain', $event)"/>
        </div>

        <!-- ─── Binning ─── -->
        <div>
          <div class="flex items-baseline justify-between">
            <span class="text-zinc-400">binning</span>
            <span class="font-mono" [class.text-amber-300]="dirtyBinning()">
              {{ valueBinning() }}×{{ valueBinning() }}
            </span>
          </div>
          <div class="flex gap-1 mt-1">
            @for (b of binPresets; track b) {
              <button
                class="flex-1 rounded px-2 py-1 text-[10px]"
                [class]="valueBinning() === b ? 'bg-emerald-700 text-emerald-50' : 'bg-zinc-800 hover:bg-zinc-700'"
                (click)="set('binning', b)">
                {{ b }}×{{ b }}
              </button>
            }
          </div>
        </div>

        <!-- ─── Search radius ─── -->
        <div>
          <div class="flex items-baseline justify-between">
            <span class="text-zinc-400">wide search r (px)</span>
            <span class="font-mono" [class.text-amber-300]="dirtySearchR()">
              {{ valueSearchR() }}
            </span>
          </div>
          <input type="range" class="w-full accent-emerald-500"
                 min="50" max="900" step="10"
                 [ngModel]="valueSearchR()"
                 (ngModelChange)="set('wide_search_radius_px', $event)"/>
        </div>

        <!-- ─── Apply / Reset ─── -->
        <div class="flex items-center gap-2 pt-1">
          <button
            class="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            [class]="hasDirty() ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-zinc-800 text-zinc-500'"
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
export class CameraPanelComponent {
  state = input<PipelineState | undefined>(undefined);
  applyPatch = output<Record<string, unknown>>();

  rpcStatus = signal<{ ok: boolean; message: string } | null>(null);

  /** Sparse map of operator edits. Empty when nothing dirty. */
  private overrides = signal<Partial<Snapshot>>({});

  /** Pure projection of the upstream input state — never written. */
  upstream = computed<Snapshot | null>(() => {
    const s = this.state();
    if (!s) return null;
    return {
      exp_time: s.exp_time,
      gain: s.gain ?? null,
      binning: s.binning,
      wide_search_radius_px: s.wide_search_radius_px,
    };
  });

  readonly expPresets = [0.1, 0.5, 1, 2, 5];
  readonly binPresets = [1, 2];

  // Per-field accessors — overrides shadow upstream for that field only.
  valueExpTime = computed(() => {
    const o = this.overrides();
    if ('exp_time' in o) return o.exp_time as number;
    return this.upstream()?.exp_time ?? 1;
  });
  valueGain = computed(() => {
    const o = this.overrides();
    if ('gain' in o) return o.gain ?? null;
    return this.upstream()?.gain ?? null;
  });
  valueBinning = computed(() => {
    const o = this.overrides();
    if ('binning' in o) return o.binning as number;
    return this.upstream()?.binning ?? 1;
  });
  valueSearchR = computed(() => {
    const o = this.overrides();
    if ('wide_search_radius_px' in o) return o.wide_search_radius_px as number;
    return this.upstream()?.wide_search_radius_px ?? 200;
  });

  dirtyExpTime = computed(() => 'exp_time' in this.overrides());
  dirtyGain = computed(() => 'gain' in this.overrides());
  dirtyBinning = computed(() => 'binning' in this.overrides());
  dirtySearchR = computed(() => 'wide_search_radius_px' in this.overrides());
  hasDirty = computed(() => Object.keys(this.overrides()).length > 0);

  set(field: EditableFields, value: any): void {
    this.overrides.update(o => ({ ...o, [field]: value }));
    this.rpcStatus.set(null);
  }

  apply(): void {
    const o = this.overrides();
    if (!Object.keys(o).length) return;
    this.applyPatch.emit({ ...o });
  }

  reset(): void {
    this.overrides.set({});
    this.rpcStatus.set(null);
  }

  /** Called by the parent after the RPC completes. On success, clear
   *  overrides so the panel falls back to tracking upstream. */
  reportRpc(ok: boolean, message: string): void {
    this.rpcStatus.set({ ok, message });
    if (ok) this.overrides.set({});
  }
}
