import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/**
 * Manual pulse pad. Big cardinal layout, four duration presets above it,
 * custom field for off-preset values. Keyboard shortcuts are bound at the
 * app shell level (arrow keys = N/S/E/W, 1–4 = duration preset).
 */
@Component({
  selector: 'app-pulse-pad',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="space-y-2 text-xs">
      <div class="flex items-center justify-between">
        <span class="text-zinc-400">duration</span>
        <span class="font-mono">{{ duration() }} ms</span>
      </div>
      <div class="grid grid-cols-4 gap-1">
        @for (p of presets; track p) {
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
                title="pulse N (↑)">N</button>
        <span></span>
        <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-base font-semibold"
                (click)="pulse.emit({ direction: 3, duration_ms: duration() })"
                title="pulse W (←)">W</button>
        <!-- Centre indicator: shows the ms duration so it's visible at a
             glance from the pad area itself; not interactive. -->
        <div class="aspect-square rounded-md border border-zinc-800 grid place-items-center text-[10px] text-zinc-500 font-mono">
          {{ duration() }}<br>ms
        </div>
        <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-base font-semibold"
                (click)="pulse.emit({ direction: 2, duration_ms: duration() })"
                title="pulse E (→)">E</button>
        <span></span>
        <button class="aspect-square rounded-md bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-base font-semibold"
                (click)="pulse.emit({ direction: 1, duration_ms: duration() })"
                title="pulse S (↓)">S</button>
        <span></span>
      </div>

      @if (rpcStatus(); as st) {
        <div class="text-[11px] mt-1"
             [class.text-emerald-400]="st.ok"
             [class.text-red-400]="!st.ok">{{ st.message }}</div>
      } @else {
        <div class="text-[11px] text-zinc-600 mt-1">arrow keys also work</div>
      }
    </div>
  `,
})
export class PulsePadComponent {
  pulse = output<{ direction: number; duration_ms: number }>();

  duration = signal(500);
  rpcStatus = signal<{ ok: boolean; message: string } | null>(null);
  disabled = computed(() => false);

  readonly presets = [200, 500, 1000, 2000];

  reportRpc(ok: boolean, message: string): void {
    this.rpcStatus.set({ ok, message });
  }
}
