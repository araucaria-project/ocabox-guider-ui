import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/**
 * Manual pulse pad. Two modes:
 *
 *  - **ms** (mount-axis pulses): N/S/E/W in milliseconds. The actual
 *    direction the star moves on screen depends on the per-camera
 *    transpose flag and Jacobian — operator has to know "for this
 *    camera, N moves the star right". Use for calibration probes and
 *    when precise pulse-time control is needed.
 *
 *  - **px** (image-axis pulses): ↑/↓/←/→ that move the star in the
 *    direction shown on screen. Server inverts the calibrated 2×2
 *    Jacobian to compute the matching mount-axis pulses. Operator
 *    gives "up by 30 px" — server figures out the rest. Recommended
 *    for general use; bypasses the transpose ambiguity entirely.
 *
 * Keyboard shortcuts (arrow keys, 1-4 for duration preset) are bound
 * at the app shell level. In px mode the arrows operate on the px
 * preset; in ms mode they fire N/S/E/W.
 */
@Component({
  selector: 'app-pulse-pad',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="space-y-2 text-xs">
      <!-- Mode toggle -->
      <div class="flex gap-1 text-[10px]">
        <button
          class="flex-1 rounded px-2 py-1"
          [class]="mode() === 'px' ? 'bg-emerald-700 text-emerald-50' : 'bg-zinc-800 hover:bg-zinc-700'"
          (click)="mode.set('px')"
          title="image-axis pixels — server inverts Jacobian">px (image)</button>
        <button
          class="flex-1 rounded px-2 py-1"
          [class]="mode() === 'ms' ? 'bg-emerald-700 text-emerald-50' : 'bg-zinc-800 hover:bg-zinc-700'"
          (click)="mode.set('ms')"
          title="mount-axis duration — N/S/E/W in milliseconds">ms (N/S/E/W)</button>
      </div>

      @if (mode() === 'ms') {
        <div class="flex items-center justify-between">
          <span class="text-zinc-400">duration</span>
          <span class="font-mono">{{ duration() }} ms</span>
        </div>
        <div class="grid grid-cols-4 gap-1">
          @for (p of msPresets; track p) {
            <button
              class="rounded px-2 py-1 text-[11px]"
              [class]="duration() === p ? 'bg-emerald-700 text-emerald-50' : 'bg-zinc-800 hover:bg-zinc-700'"
              (click)="duration.set(p)">{{ p }}</button>
          }
        </div>
        <input type="number" min="20" max="3000" step="10"
               class="w-full rounded bg-zinc-950 border border-zinc-800 px-2 py-1 font-mono"
               [ngModel]="duration()"
               (ngModelChange)="duration.set($event)"
               aria-label="custom pulse duration">

        <div class="grid grid-cols-3 gap-1.5 max-w-[200px] mx-auto pt-2">
          <span></span>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-base font-semibold"
                  (click)="pulse.emit({ direction: 0, duration_ms: duration() })"
                  title="pulse N (mount axis)">N</button>
          <span></span>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-base font-semibold"
                  (click)="pulse.emit({ direction: 3, duration_ms: duration() })"
                  title="pulse W (mount axis)">W</button>
          <div class="aspect-square rounded-md border border-zinc-800 grid place-items-center text-[10px] text-zinc-500 font-mono">
            {{ duration() }}<br>ms
          </div>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-700 text-base font-semibold"
                  (click)="pulse.emit({ direction: 2, duration_ms: duration() })"
                  title="pulse E (mount axis)">E</button>
          <span></span>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-base font-semibold"
                  (click)="pulse.emit({ direction: 1, duration_ms: duration() })"
                  title="pulse S (mount axis)">S</button>
          <span></span>
        </div>
      } @else {
        <!-- px (image-axis) mode -->
        <div class="flex items-center justify-between">
          <span class="text-zinc-400">step</span>
          <span class="font-mono">{{ pixels() }} px</span>
        </div>
        <div class="grid grid-cols-4 gap-1">
          @for (p of pxPresets; track p) {
            <button
              class="rounded px-2 py-1 text-[11px]"
              [class]="pixels() === p ? 'bg-emerald-700 text-emerald-50' : 'bg-zinc-800 hover:bg-zinc-700'"
              (click)="pixels.set(p)">{{ p }}</button>
          }
        </div>
        <input type="number" min="1" max="500" step="1"
               class="w-full rounded bg-zinc-950 border border-zinc-800 px-2 py-1 font-mono"
               [ngModel]="pixels()"
               (ngModelChange)="pixels.set($event)"
               aria-label="custom pixel step">

        <!-- Image-axis arrows. Sign convention: image-Y goes DOWN
             (browser raster), so ↑ = -Y, ↓ = +Y, ← = -X, → = +X.
             Server's pulse_pixels takes (dx_px, dy_px) verbatim. -->
        <div class="grid grid-cols-3 gap-1.5 max-w-[200px] mx-auto pt-2">
          <span></span>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-lg font-semibold"
                  (click)="pulsePx.emit({ dx_px: 0, dy_px: -pixels() })"
                  title="move star up (image −Y)">↑</button>
          <span></span>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-lg font-semibold"
                  (click)="pulsePx.emit({ dx_px: -pixels(), dy_px: 0 })"
                  title="move star left (image −X)">←</button>
          <div class="aspect-square rounded-md border border-zinc-800 grid place-items-center text-[10px] text-zinc-500 font-mono">
            {{ pixels() }}<br>px
          </div>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-lg font-semibold"
                  (click)="pulsePx.emit({ dx_px: pixels(), dy_px: 0 })"
                  title="move star right (image +X)">→</button>
          <span></span>
          <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-lg font-semibold"
                  (click)="pulsePx.emit({ dx_px: 0, dy_px: pixels() })"
                  title="move star down (image +Y)">↓</button>
          <span></span>
        </div>
      }

      @if (rpcStatus(); as st) {
        <div class="text-[11px] mt-1"
             [class.text-emerald-400]="st.ok"
             [class.text-red-400]="!st.ok">{{ st.message }}</div>
      } @else {
        <div class="text-[11px] text-zinc-600 mt-1">arrow keys move the star on screen (px mode)</div>
      }
    </div>
  `,
})
export class PulsePadComponent {
  /** ms-mode pulse — direction is ASCOM code 0=N 1=S 2=E 3=W. */
  pulse = output<{ direction: number; duration_ms: number }>();
  /** px-mode pulse — image-axis pixel target. Server does Jacobian. */
  pulsePx = output<{ dx_px: number; dy_px: number }>();

  /** Current pad mode — persisted in localStorage so an operator who
   *  picked their preferred mode keeps it across reloads. */
  mode = signal<'ms' | 'px'>(this.loadMode());

  duration = signal(500);
  pixels = signal(30);
  rpcStatus = signal<{ ok: boolean; message: string } | null>(null);
  disabled = computed(() => false);

  readonly msPresets = [200, 500, 1000, 2000];
  readonly pxPresets = [10, 30, 100, 200];

  constructor() {
    // Persist mode on every toggle. Single source of truth = signal,
    // so we hook write-through via setter override.
    const orig = this.mode.set.bind(this.mode);
    this.mode.set = (v: 'ms' | 'px') => {
      orig(v);
      try { localStorage.setItem('ocabox-guider.pulse-mode', v); } catch { /* ignore */ }
    };
  }

  reportRpc(ok: boolean, message: string): void {
    this.rpcStatus.set({ ok, message });
  }

  private loadMode(): 'ms' | 'px' {
    try {
      const v = localStorage.getItem('ocabox-guider.pulse-mode');
      if (v === 'ms' || v === 'px') return v;
    } catch { /* ignore */ }
    return 'px';  // default — image-axis is the more intuitive choice
  }
}
