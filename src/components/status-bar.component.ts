import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuiderInfo, PipelineState } from '../services/guider.store';

/**
 * Footer status bar — always-visible service-health summary plus key
 * single-shot data. Shows the standard TCS framework info that comes
 * along on every `svc.status` message (pid, hostname) so the operator
 * doesn't need to leave the dashboard to verify which process they're
 * talking to.
 */
@Component({
  selector: 'app-status-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="flex items-center gap-4 text-[11px] font-mono px-3 py-1 bg-zinc-950 border-t border-zinc-800 text-zinc-400 overflow-x-auto whitespace-nowrap">
      <span class="text-zinc-100">{{ guider()?.instance ?? '—' }}</span>
      <span [class.text-emerald-400]="isHealthy()" [class.text-red-400]="!isHealthy()">
        {{ guider()?.service_status ?? 'unknown' }}
      </span>
      <span>v{{ state()?.version ?? 0 }}</span>

      <span class="text-zinc-700">·</span>

      <span>acquired: {{ state()?.acquired ? 'yes' : 'no' }}</span>
      @if (state()?.acquired_pos; as p) {
        <span>star ({{ p[0] | number:'1.2-2' }}, {{ p[1] | number:'1.2-2' }})</span>
      }
      @if (state()?.central_point; as c) {
        <span>reticle ({{ c[0] | number:'1.2-2' }}, {{ c[1] | number:'1.2-2' }})</span>
      }
      @if (state()?.exp_time; as e) {
        <span>exp {{ e }}s</span>
      }

      <span class="flex-1"></span>

      @if (guider()?.hostname; as h) {
        <span class="text-zinc-600">host {{ h }}</span>
      }
      @if (guider()?.pid; as pid) {
        <span class="text-zinc-600">pid {{ pid }}</span>
      }
      @if (guider()?.started_at; as t) {
        <span class="text-zinc-600">up {{ uptime() }}</span>
      }
    </div>
  `,
})
export class StatusBarComponent {
  guider = input<GuiderInfo | undefined>(undefined);
  state = input<PipelineState | undefined>(undefined);

  /** Reactive clock so the uptime updates every second without re-rendering
   *  the rest of the bar. Pure UI sugar — could be removed if it shows up
   *  in profiling. */
  private now = signal(Date.now());

  constructor() {
    if (typeof window !== 'undefined') {
      setInterval(() => this.now.set(Date.now()), 1000);
    }
  }

  isHealthy = computed(() => {
    const s = this.guider()?.service_status;
    return s === 'ok' || s === 'idle' || s === 'busy';
  });

  uptime = computed(() => {
    const start = this.guider()?.started_at;
    if (!start || start.length < 7) return '—';
    const startMs = Date.UTC(start[0], start[1] - 1, start[2], start[3], start[4], start[5], start[6] / 1000);
    const sec = Math.max(0, Math.floor((this.now() - startMs) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  });
}
