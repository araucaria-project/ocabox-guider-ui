import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriftPoint, GuiderInfo, GuiderStore, PipelineState } from '../services/guider.store';
import { FrameViewComponent } from './frame-view.component';
import { DriftChartComponent } from './drift-chart.component';
import { ScatterPlotComponent } from './scatter-plot.component';
import { ModeToolbarComponent } from './mode-toolbar.component';
import { CameraPanelComponent } from './camera-panel.component';
import { PulsePadComponent } from './pulse-pad.component';
import { CalibrationPanelComponent, ProbeRunner } from './calibration-panel.component';
import { JournalPanelComponent } from './journal-panel.component';
import { StatusBarComponent } from './status-bar.component';
import { ReticleStyle } from './reticle.component';

const RETICLE_KEY = 'ocabox-guider.reticle';

/**
 * Workshop-style dashboard for one discovered guider instance.
 *
 * Layout (≥xl):
 *
 *   ┌── mode toolbar ─────────────────────────────────────┐
 *   │                                                     │
 *   │  ┌── frame ──┐  ┌── drift ─┐  ┌── camera ─┐          │
 *   │  │           │  │ chart    │  │ controls  │          │
 *   │  │  canvas   │  ├── RMS    │  ├── pulse   │          │
 *   │  │           │  │          │  │ pad       │          │
 *   │  │           │  ├── journal│  │           │          │
 *   │  └───────────┘  └──────────┘  └───────────┘          │
 *   │                                                     │
 *   └── status bar ───────────────────────────────────────┘
 *
 * On smaller viewports the columns stack. Keyboard shortcuts (defined at
 * the app shell level) drive mode/pulse without touching the mouse.
 */
@Component({
  selector: 'app-guider-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FrameViewComponent,
    DriftChartComponent,
    ScatterPlotComponent,
    ModeToolbarComponent,
    CameraPanelComponent,
    PulsePadComponent,
    CalibrationPanelComponent,
    JournalPanelComponent,
    StatusBarComponent,
  ],
  template: `
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <app-mode-toolbar
        [state]="state()"
        [reticle]="reticle()"
        (modeRequested)="setMode($event)"
        (acquireRequested)="acquire()"
        (dropToReticleRequested)="dropToReticle()"
        (reticleHomeRequested)="reticleHome()"
        (reticleChanged)="setReticle($event)"
      ></app-mode-toolbar>

      <div class="grid grid-cols-1 xl:grid-cols-12 gap-px bg-zinc-900">
        <!-- ─── Frame ─── -->
        <div class="xl:col-span-7 bg-zinc-950 min-h-[400px] xl:min-h-[600px]">
          <app-frame-view
            #frame
            [state]="state()"
            [instance]="guider().instance"
            [reticle]="reticle()"
            (lockAt)="lockAt($event.x, $event.y)"
            (acquireAt)="acquireAt($event.x, $event.y)"
          ></app-frame-view>
        </div>

        <!-- ─── Telemetry ─── -->
        <div class="xl:col-span-3 bg-zinc-950 p-3 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-[11px] uppercase tracking-wider text-zinc-500">drift error</div>
            <div class="flex items-center gap-1">
              <button
                class="rounded text-[10px] px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
                (click)="exportCsv()"
                title="download drift history as CSV">
                export
              </button>
              <button
                class="rounded text-[10px] px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
                (click)="clearDrift()"
                title="clear drift history (resets RMS)">
                clear
              </button>
              <button
                class="rounded text-[10px] px-1.5 py-0.5"
                [class]="frozen() ? 'bg-amber-700/80 text-amber-50' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'"
                (click)="toggleFrozen()"
                [title]="frozen() ? 'resume updates' : 'freeze: pause state + drift updates'">
                {{ frozen() ? '⏸ frozen' : '⏵ live' }}
              </button>
            </div>
          </div>

          <div class="grid grid-cols-[1fr_auto] gap-2 items-start">
            <app-drift-chart [points]="driftPoints()"></app-drift-chart>
            <app-scatter-plot [points]="driftPoints()"></app-scatter-plot>
          </div>

          <!-- RMS readouts -->
          <div class="grid grid-cols-3 gap-2 text-xs">
            <div class="rounded bg-zinc-900 px-2 py-1.5 border border-zinc-800">
              <div class="text-rose-400 text-[10px] uppercase">RA RMS</div>
              <div class="font-mono text-base">{{ rmsRA() | number:'1.2-2' }}</div>
              <div class="text-[10px] text-zinc-500">px</div>
            </div>
            <div class="rounded bg-zinc-900 px-2 py-1.5 border border-zinc-800">
              <div class="text-sky-400 text-[10px] uppercase">Dec RMS</div>
              <div class="font-mono text-base">{{ rmsDec() | number:'1.2-2' }}</div>
              <div class="text-[10px] text-zinc-500">px</div>
            </div>
            <div class="rounded bg-zinc-900 px-2 py-1.5 border border-zinc-800">
              <div class="text-zinc-300 text-[10px] uppercase">total</div>
              <div class="font-mono text-base">{{ rmsTotal() | number:'1.2-2' }}</div>
              <div class="text-[10px] text-zinc-500">px · n={{ rmsN() }}</div>
            </div>
          </div>

          <!-- Spot diagnostics from the latest state -->
          <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono text-zinc-300 pt-1 border-t border-zinc-800">
            <div class="text-zinc-500">acquired</div>
            <div [class.text-emerald-400]="state()?.acquired" [class.text-zinc-400]="!state()?.acquired">
              {{ state()?.acquired ? 'yes' : 'no' }}
            </div>
            <div class="text-zinc-500">FWHM</div>
            <div>{{ state()?.fwhm_recent ?? '—' }}</div>
            <div class="text-zinc-500">last Δ (px)</div>
            <div>
              {{ state()?.last_correction_dx_px ?? '—' }},
              {{ state()?.last_correction_dy_px ?? '—' }}
            </div>
            <div class="text-zinc-500">acquired_adu</div>
            <div>{{ state()?.acquired_adu ?? '—' }}</div>
          </div>

          <div class="pt-1 border-t border-zinc-800">
            <div class="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">journal</div>
            <app-journal-panel
              [events]="events()"
              [journal]="journals()"
            ></app-journal-panel>
          </div>
        </div>

        <!-- ─── Controls ─── -->
        <div class="xl:col-span-2 bg-zinc-950 p-3 space-y-4 border-l border-zinc-800">
          <div>
            <div class="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">camera</div>
            <app-camera-panel
              #cam
              [state]="state()"
              (applyPatch)="applyCameraPatch($event)"
            ></app-camera-panel>
          </div>
          <div>
            <div class="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">manual pulse</div>
            <app-pulse-pad
              #pad
              (pulse)="manualPulse($event)"
            ></app-pulse-pad>
          </div>
          <div>
            <app-calibration-panel
              [state]="state()"
              [runProbe]="probeRunner"
            ></app-calibration-panel>
          </div>
        </div>
      </div>

      <app-status-bar
        [guider]="guider()"
        [state]="state()"
      ></app-status-bar>
    </div>
  `,
})
export class GuiderDashboardComponent {
  store = inject(GuiderStore);
  guider = input.required<GuiderInfo>();

  cameraPanel = viewChild<CameraPanelComponent>('cam');
  pulsePad = viewChild<PulsePadComponent>('pad');
  frameView = viewChild<FrameViewComponent>('frame');

  reticle = signal<ReticleStyle>(this.loadReticle());

  /**
   * Freeze model — local to this dashboard.
   *
   * `freezeFrame` holds either `null` (live: read upstream signals) or a
   * snapshot object captured at the moment the operator clicked freeze.
   * Toggling freeze is a single event handler that *reads upstream once*
   * and stores the captured value — no effects, no signal write-from-read.
   *
   * `state()` and `driftPoints()` are pure computeds that branch on
   * `freezeFrame()`: if non-null, return the snapshot's payload; if null,
   * project from the upstream store. There is no path by which the
   * snapshot signals depend on the upstream signals at runtime.
   */
  private freezeFrame = signal<{ state: PipelineState | undefined; drift: DriftPoint[] } | null>(null);

  frozen = computed(() => this.freezeFrame() !== null);

  state = computed<PipelineState | undefined>(() => {
    const fr = this.freezeFrame();
    if (fr) return fr.state;
    const g = this.guider();
    if (!g.pipelines.length) return undefined;
    return this.store.states().get(`${g.instance}::${g.pipelines[0].id}`);
  });

  driftPoints = computed<DriftPoint[]>(() => {
    const fr = this.freezeFrame();
    if (fr) return fr.drift;
    const g = this.guider();
    if (!g.pipelines.length) return [];
    return this.store.drift().get(`${g.instance}::${g.pipelines[0].id}`) ?? [];
  });

  toggleFrozen(): void {
    if (this.freezeFrame()) {
      this.freezeFrame.set(null);
      return;
    }
    const g = this.guider();
    const key = g.pipelines.length ? `${g.instance}::${g.pipelines[0].id}` : '';
    this.freezeFrame.set({
      state: this.store.states().get(key),
      drift: [...(this.store.drift().get(key) ?? [])],
    });
  }

  private rmsObj = computed(() => {
    const g = this.guider();
    if (!g.pipelines.length) return null;
    return this.store.rms().get(`${g.instance}::${g.pipelines[0].id}`) ?? null;
  });

  rmsRA = computed(() => this.rmsObj()?.ra ?? 0);
  rmsDec = computed(() => this.rmsObj()?.dec ?? 0);
  rmsTotal = computed(() => this.rmsObj()?.total ?? 0);
  rmsN = computed(() => this.rmsObj()?.n ?? 0);

  events = computed(() => this.store.events().get(this.guider().instance) ?? []);
  journals = computed(() => this.store.journals().get(this.guider().instance) ?? []);

  private firstPipelineId(): string {
    return this.guider().pipelines[0]?.id ?? 'mon';
  }

  setReticle(r: ReticleStyle): void {
    this.reticle.set(r);
    try { localStorage.setItem(RETICLE_KEY, r); } catch { /* ignore */ }
  }

  exportCsv(): void {
    this.store.exportDriftCsv(this.guider().instance, this.firstPipelineId());
  }

  clearDrift(): void {
    this.store.clearDrift(this.guider().instance, this.firstPipelineId());
  }

  private loadReticle(): ReticleStyle {
    try {
      const v = localStorage.getItem(RETICLE_KEY);
      if (v && (['classic', 'scifi', 'fighter', 'tank', 'finder', 'sniper'] as ReticleStyle[]).includes(v as ReticleStyle)) {
        return v as ReticleStyle;
      }
    } catch { /* ignore */ }
    return 'classic';
  }

  setMode(mode: string): void {
    this.runRpc(`set_mode(${mode})`, () =>
      this.store.setMode(this.guider().instance, this.firstPipelineId(), mode));
  }

  acquire(): void {
    this.runRpc('acquire', () =>
      this.store.acquire(this.guider().instance, this.firstPipelineId()));
  }

  dropToReticle(): void {
    this.runRpc('drop_to_reticle', () =>
      this.store.dropToReticle(this.guider().instance, this.firstPipelineId()));
  }

  /** Restore the reticle to its camera-default position (from YAML
   *  config, exposed by the server as ``state.central_point_default``).
   *  Issued via ``acquire_at`` since that's the existing reticle-move
   *  RPC — operator drags via right-click → ``acquire_at``, "home"
   *  button = ``acquire_at`` to the configured default. */
  reticleHome(): void {
    const def = this.state()?.central_point_default;
    if (!def) return;
    const [x, y] = def;
    this.runRpc('reticle_home', () =>
      this.store.acquireAt(this.guider().instance, this.firstPipelineId(), x, y));
  }

  /** Bound RPC entry-point passed into ``<app-calibration-panel>``.
   *  Defined as a field-arrow so ``this`` stays correct when invoked
   *  from the child without rebinding. The panel doesn't need to know
   *  about NATS, GuiderStore, or which pipeline is "first" — that
   *  routing happens here. */
  probeRunner: ProbeRunner = (direction, durationMs) =>
    this.store.calibrateProbe(
      this.guider().instance, this.firstPipelineId(), direction, durationMs,
    );

  zoomIn(): void { this.frameView()?.zoomIn(); }
  zoomOut(): void { this.frameView()?.zoomOut(); }
  zoomHome(): void { this.frameView()?.home(); }
  toggleCandidates(): void { this.frameView()?.toggleCandidates(); }
  cycleCandidate(delta: number = 1): void { this.frameView()?.cycleCandidate(delta); }

  acquireAt(x: number, y: number): void {
    this.runRpc(`acquire_at(${Math.round(x)}, ${Math.round(y)})`, () =>
      this.store.acquireAt(this.guider().instance, this.firstPipelineId(), x, y));
  }

  lockAt(x: number, y: number): void {
    this.runRpc(`lock_at(${Math.round(x)}, ${Math.round(y)})`, () =>
      this.store.lockAt(this.guider().instance, this.firstPipelineId(), x, y));
  }

  applyCameraPatch(patch: Record<string, unknown>): void {
    const ok = (msg: string) => this.cameraPanel()?.reportRpc(true, msg);
    const fail = (msg: string) => this.cameraPanel()?.reportRpc(false, msg);
    const label = `set_state ${Object.keys(patch).join('+')}`;
    this.store.setState(this.guider().instance, this.firstPipelineId(), patch)
      .then((res: any) => {
        const status = res?.status;
        if (status === 'ok') ok(`${label} ok`);
        else fail(`${label} failed: ${res?.error ?? '?'}`);
      })
      .catch(e => fail(`${label} error: ${(e as Error).message ?? e}`));
  }

  manualPulse(p: { direction: number; duration_ms: number }): void {
    const label = `pulse(${'NSEW'[p.direction] ?? p.direction}, ${p.duration_ms}ms)`;
    this.store.manualPulse(this.guider().instance, this.firstPipelineId(), p.direction, p.duration_ms)
      .then((res: any) => {
        const ok = res?.status === 'ok';
        this.pulsePad()?.reportRpc(ok, ok ? `${label} ok` : `${label} failed: ${res?.error ?? '?'}`);
      })
      .catch(e => this.pulsePad()?.reportRpc(false, `${label} error: ${(e as Error).message ?? e}`));
  }

  private runRpc(label: string, op: () => Promise<unknown>): void {
    op().then((res: any) => {
      const ok = res?.status === 'ok';
      // Reuse the camera panel's status line for general RPC feedback so the
      // operator always has one place to look. Could become its own widget.
      this.cameraPanel()?.reportRpc(ok, ok ? `${label} ok` : `${label} failed: ${res?.error ?? '?'}`);
    }).catch(e => this.cameraPanel()?.reportRpc(false, `${label} error: ${(e as Error).message ?? e}`));
  }
}
