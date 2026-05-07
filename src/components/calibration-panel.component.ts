import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PipelineState } from '../services/guider.store';

/**
 * One row of the calibration results table — what we got back from
 * a single ``calibrate_probe`` RPC.
 */
export interface ProbeResult {
  direction: 'N' | 'S' | 'E' | 'W';
  duration_ms: number;
  dx: number;
  dy: number;
  k_x_per_ms: number;
  k_y_per_ms: number;
  pos_before: [number, number];
  pos_after: [number, number];
  ts: number;  // local-clock millis when the row was added
}

/** Patch shape used by the parent to invoke the actual RPC. Returns
 *  the server's response (success or error). Decoupled so this panel
 *  stays oblivious to NATS / store internals. */
export type ProbeRunner = (
  direction: 'N' | 'S' | 'E' | 'W',
  duration_ms: number,
) => Promise<unknown>;

/**
 * Calibration probe panel.
 *
 * Operator clicks N/S/E/W with a chosen duration; the parent fires the
 * ``calibrate_probe`` RPC; results stack up in a small table here.
 * Once the operator has at least one N (or S) probe and one E (or W)
 * probe the panel computes a suggested 2×2 Jacobian for copy-paste
 * into the YAML config.
 *
 * Architecture:
 *   - All UI state is local to this component (results history,
 *     in-flight marker, last error).
 *   - The actual RPC is supplied as a ``runProbe`` input — keeps this
 *     component free of GuiderStore/NATS knowledge so it's testable in
 *     isolation and reusable for non-BESO setups.
 *   - No effects: every state mutation is a direct response to a user
 *     event handler. Reads are pure computeds.
 *   - Button enablement reads current pipeline state (mode + acquired)
 *     — operator can't fire a probe that the server will reject.
 */
@Component({
  selector: 'app-calibration-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="space-y-2 text-xs">

      <button
        class="w-full flex items-baseline justify-between hover:text-zinc-200"
        (click)="toggleExpanded()"
        [title]="expanded() ? 'collapse calibration panel' : 'expand calibration panel'">
        <div class="text-zinc-400 uppercase text-[10px] tracking-wider">
          {{ expanded() ? '▾' : '▸' }} calibration
          @if (!expanded() && results().length > 0) {
            <span class="text-zinc-500 text-[10px] normal-case ml-1">({{ results().length }})</span>
          }
        </div>
        @if (results().length > 0 && expanded()) {
          <span
            class="text-[10px] text-zinc-500 hover:text-zinc-300"
            (click)="clear(); $event.stopPropagation()"
            role="button">
            clear
          </span>
        }
      </button>

      @if (expanded()) {
      @if (!ready()) {
        <div class="text-amber-400/90 text-[11px] leading-snug">
          {{ disabledReason() }}
        </div>
      }

      <div class="flex items-center gap-1.5">
        <span class="text-zinc-500 w-12">duration</span>
        <input type="number" min="20" max="5000" step="50"
               [(ngModel)]="durationMs"
               class="w-16 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs font-mono"/>
        <span class="text-zinc-500">ms</span>
      </div>

      <div class="grid grid-cols-3 gap-0.5">
        <div></div>
        <button class="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-2 py-1 font-medium"
                [disabled]="!ready() || inFlight() !== null"
                (click)="probe('N')">N</button>
        <div></div>
        <button class="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-2 py-1 font-medium"
                [disabled]="!ready() || inFlight() !== null"
                (click)="probe('W')">W</button>
        <div class="grid place-items-center text-[10px] text-zinc-600 font-mono">
          @if (inFlight(); as f) {
            {{ f.direction }}…
          } @else {
            {{ durationMs() }}ms
          }
        </div>
        <button class="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-2 py-1 font-medium"
                [disabled]="!ready() || inFlight() !== null"
                (click)="probe('E')">E</button>
        <div></div>
        <button class="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-2 py-1 font-medium"
                [disabled]="!ready() || inFlight() !== null"
                (click)="probe('S')">S</button>
        <div></div>
      </div>

      @if (lastError(); as e) {
        <div class="text-red-400/90 text-[10px] font-mono leading-tight">
          {{ e }}
        </div>
      }

      @if (results().length > 0) {
        <table class="w-full text-[10px] font-mono border-t border-zinc-800 pt-1">
          <thead class="text-zinc-500">
            <tr>
              <th class="text-left">dir</th>
              <th class="text-right">ms</th>
              <th class="text-right">Δx</th>
              <th class="text-right">Δy</th>
              <th class="text-right">k<sub>x</sub>/ms</th>
              <th class="text-right">k<sub>y</sub>/ms</th>
            </tr>
          </thead>
          <tbody class="text-zinc-200">
            @for (r of results(); track r.ts) {
              <tr [class.opacity-40]="droppedTimestamps().has(r.ts)"
                  [title]="droppedTimestamps().has(r.ts) ? 'dropped from Jacobian (backlash — first probe after direction switch)' : ''">
                <td>{{ r.direction }}@if (droppedTimestamps().has(r.ts)) {<span class="text-amber-300/80 ml-1">⌀</span>}</td>
                <td class="text-right">{{ r.duration_ms }}</td>
                <td class="text-right" [class.text-rose-400]="r.dx < 0" [class.text-emerald-400]="r.dx > 0">
                  {{ r.dx | number:'1.2-2' }}
                </td>
                <td class="text-right" [class.text-rose-400]="r.dy < 0" [class.text-emerald-400]="r.dy > 0">
                  {{ r.dy | number:'1.2-2' }}
                </td>
                <td class="text-right">{{ r.k_x_per_ms | number:'1.5-5' }}</td>
                <td class="text-right">{{ r.k_y_per_ms | number:'1.5-5' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      @if (suggestedJacobian(); as j) {
        <div class="border-t border-zinc-800 pt-1.5 space-y-1">
          <div class="text-zinc-500 text-[10px] uppercase">suggested YAML (full 2×2, median, backlash-filtered)</div>
          <pre class="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] font-mono leading-tight overflow-x-auto"
>jacobian:
  kE_x_px_per_ms: {{ j.kE_x | number:'1.5-5' }}
  kE_y_px_per_ms: {{ j.kE_y | number:'1.5-5' }}
  kN_x_px_per_ms: {{ j.kN_x | number:'1.5-5' }}
  kN_y_px_per_ms: {{ j.kN_y | number:'1.5-5' }}</pre>
          <div class="text-[10px] text-zinc-500 leading-snug">
            @if (filteredProbes().droppedCount > 0) {
              <span class="text-amber-300/80">backlash-dropped: {{ filteredProbes().droppedCount }} first-of-direction probe(s)</span>
              ·
            }
            using {{ filteredProbes().N.length }}N / {{ filteredProbes().S.length }}S /
            {{ filteredProbes().E.length }}E / {{ filteredProbes().W.length }}W ·
            median over surviving probes.
            For best results: ≥2 probes per direction at long pulse (≥1000ms)
            and long settle (≥2500ms).
          </div>
        </div>
      }
      }
    </div>
  `,
})
export class CalibrationPanelComponent {
  state = input<PipelineState | undefined>(undefined);
  /** Parent supplies the actual RPC entry point. Keeps this component
   *  free of NATS / store knowledge. Returns server response. */
  runProbe = input.required<ProbeRunner>();

  /** Probe duration the operator picks. Local to this widget. */
  durationMs = signal<number>(500);

  /** Collapsed by default — calibration is rare. Click the header to
   *  expand. Persists to localStorage so an in-progress calibration
   *  survives page reload. */
  expanded = signal<boolean>(this.loadExpanded());

  /** History of probe results — newest at top. */
  results = signal<ProbeResult[]>([]);

  /** When non-null, a probe is in flight; buttons disable. Cleared
   *  on RPC completion (success or error). */
  inFlight = signal<{ direction: 'N' | 'S' | 'E' | 'W'; duration_ms: number } | null>(null);

  /** Last error message (server-side validation failure, lock loss,
   *  timeout). Cleared on next successful probe. */
  lastError = signal<string | null>(null);

  /** Whether server-side pre-conditions are satisfied right now. We
   *  could let the operator click and get a server-side error back,
   *  but disabling pre-emptively is friendlier. */
  ready = computed(() => {
    const s = this.state();
    return !!s && s.acquired && s.mode === 'monitoring';
  });

  disabledReason = computed(() => {
    const s = this.state();
    if (!s) return 'no pipeline state — waiting…';
    if (s.mode !== 'monitoring') return `switch mode to monitoring (currently ${s.mode})`;
    if (!s.acquired) return 'lock onto a star first';
    return '';
  });

  /** Per-probe drop decision keyed by probe timestamp. A probe is
   *  dropped when:
   *   - it's the first of its direction *after a direction switch*
   *     (or the very first probe ever) — the backlash signature, and
   *   - dropping it leaves ≥1 surviving probe of the same direction
   *     (we don't drop the only sample of a direction; some signal
   *     beats none).
   *  Computed independently of ``filteredProbes`` so the table can
   *  visually flag dropped rows without splitting the data twice. */
  droppedTimestamps = computed<Set<number>>(() => {
    const firingOrder = [...this.results()].reverse();
    const counts: Record<'N' | 'S' | 'E' | 'W', number> = { N: 0, S: 0, E: 0, W: 0 };
    const candidates: ProbeResult[] = [];
    let prevDir: string | null = null;
    for (const r of firingOrder) {
      counts[r.direction] += 1;
      if (prevDir === null || prevDir !== r.direction) candidates.push(r);
      prevDir = r.direction;
    }
    const dropped = new Set<number>();
    for (const r of candidates) {
      if (counts[r.direction] >= 2) dropped.add(r.ts);
    }
    return dropped;
  });

  /** Per-direction probes after backlash filtering, plus dropped count.
   *  Driven off ``droppedTimestamps`` so the table fade and the
   *  Jacobian estimator are guaranteed consistent. */
  filteredProbes = computed<{ N: ProbeResult[]; S: ProbeResult[]; E: ProbeResult[]; W: ProbeResult[]; droppedCount: number }>(() => {
    const dropped = this.droppedTimestamps();
    const out = { N: [] as ProbeResult[], S: [] as ProbeResult[], E: [] as ProbeResult[], W: [] as ProbeResult[], droppedCount: dropped.size };
    for (const r of this.results()) {
      if (!dropped.has(r.ts)) out[r.direction].push(r);
    }
    return out;
  });

  /** Compute a suggested 2×2 Jacobian from the filtered probes.
   *  Uses the **median** of per-probe ``(k_x_per_ms, k_y_per_ms)``
   *  components per direction (independently for X and Y), then
   *  symmetrises N↔S and E↔W. Median resists residual outliers from
   *  lock-hopping or partial backlash that survive the
   *  drop-first-probe filter. */
  suggestedJacobian = computed<{ kN_x: number; kN_y: number; kE_x: number; kE_y: number } | null>(() => {
    const fp = this.filteredProbes();
    const median = (xs: number[]): number => {
      if (xs.length === 0) return NaN;
      const s = [...xs].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
    };
    const ksOf = (probes: ProbeResult[]) => {
      if (probes.length === 0) return null;
      return { kx: median(probes.map(p => p.k_x_per_ms)), ky: median(probes.map(p => p.k_y_per_ms)) };
    };
    const collect = (primary: 'N' | 'E', opposite: 'S' | 'W') => {
      const p = ksOf(fp[primary]);
      const o = ksOf(fp[opposite]);
      if (p && o) return { kx: (p.kx - o.kx) / 2, ky: (p.ky - o.ky) / 2 };
      if (p) return p;
      if (o) return { kx: -o.kx, ky: -o.ky };
      return null;
    };
    const n = collect('N', 'S');
    const e = collect('E', 'W');
    if (!n || !e) return null;
    return { kN_x: n.kx, kN_y: n.ky, kE_x: e.kx, kE_y: e.ky };
  });

  async probe(direction: 'N' | 'S' | 'E' | 'W'): Promise<void> {
    if (!this.ready() || this.inFlight() !== null) return;
    const ms = Math.max(20, Math.min(5000, Math.round(this.durationMs())));
    this.inFlight.set({ direction, duration_ms: ms });
    this.lastError.set(null);
    try {
      // Server's `_wrap_handler` wraps the controller payload as
      //   {status: 'ok', result: <controller-return>, ts: [...]}
      // on success — or {status: 'error', error, detail, ts} on RPC
      // failure. The controller's *own* error path puts {status: 'error',
      // error: '...'} inside the `result`. Two layers, two checks.
      const envelope = (await this.runProbe()(direction, ms)) as Record<string, any>;
      if (envelope?.['status'] !== 'ok') {
        this.lastError.set(String(envelope?.['error'] ?? 'RPC failed'));
        return;
      }
      const resp = (envelope['result'] ?? {}) as Record<string, any>;
      if (resp['status'] === 'ok') {
        const row: ProbeResult = {
          direction,
          duration_ms: ms,
          dx: Number(resp['dx']) || 0,
          dy: Number(resp['dy']) || 0,
          k_x_per_ms: Number(resp['k_x_per_ms']) || 0,
          k_y_per_ms: Number(resp['k_y_per_ms']) || 0,
          pos_before: resp['pos_before'] as [number, number],
          pos_after: resp['pos_after'] as [number, number],
          ts: Date.now(),
        };
        // Newest first.
        this.results.update(arr => [row, ...arr]);
      } else {
        this.lastError.set(String(resp['error'] ?? 'probe failed (no error message)'));
      }
    } catch (err) {
      this.lastError.set((err as Error)?.message ?? String(err));
    } finally {
      this.inFlight.set(null);
    }
  }

  clear(): void {
    this.results.set([]);
    this.lastError.set(null);
  }

  /** Event-driven persistence: save on every toggle. Keeps us free of
   *  effects (paradigm rule: no signal-write-from-read). */
  toggleExpanded(): void {
    const next = !this.expanded();
    this.expanded.set(next);
    try { localStorage.setItem('calibration.expanded', next ? '1' : '0'); }
    catch { /* ignore */ }
  }

  private loadExpanded(): boolean {
    try { return localStorage.getItem('calibration.expanded') === '1'; }
    catch { return false; }
  }
}
