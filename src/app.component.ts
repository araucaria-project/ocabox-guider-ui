import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, effect, inject, signal, viewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NatsService } from './services/nats.service';
import { GuiderStore } from './services/guider.store';
import { ConnectDialogComponent } from './components/connect-dialog.component';
import { GuiderDashboardComponent } from './components/guider-dashboard.component';

/**
 * App shell — header, optional connect dialog, dashboards for each
 * discovered guider. Holds the global keyboard-shortcut surface.
 *
 * Connect dialog can be collapsed once the connection is healthy so it
 * doesn't take up real estate during a session.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ConnectDialogComponent, GuiderDashboardComponent],
  template: `
    <div class="min-h-screen flex flex-col">
      <header class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
        <div class="flex items-baseline gap-3">
          <div class="text-base font-semibold">ocabox guider</div>
          <div class="text-[11px] text-zinc-500">
            FL2 web UI · {{ store.guidersList().length }} guider(s) discovered
          </div>
        </div>
        <div class="flex items-center gap-3 text-xs text-zinc-400">
          <span class="font-mono">{{ nats.serverUrl() }}</span>
          <span class="inline-flex items-center gap-1">
            <span class="h-2 w-2 rounded-full"
                  [class.bg-emerald-500]="nats.isConnected()"
                  [class.bg-amber-500]="nats.isConnecting()"
                  [class.bg-zinc-600]="!nats.isConnected() && !nats.isConnecting()"></span>
            <span>msgs: {{ nats.messagesReceived() }}</span>
          </span>
          <button
            class="rounded bg-zinc-800 hover:bg-zinc-700 px-2 py-1 text-xs"
            (click)="connectionOpen.set(!connectionOpen())">
            {{ connectionOpen() ? 'hide' : 'connection' }}
          </button>
          <button
            class="rounded bg-zinc-800 hover:bg-zinc-700 px-2 py-1 text-xs"
            (click)="shortcutsOpen.set(!shortcutsOpen())"
            title="keyboard shortcuts (?)">?</button>
        </div>
      </header>

      <main class="flex-1 px-3 py-3 space-y-3">
        @if (connectionOpen()) {
          <app-connect-dialog></app-connect-dialog>
        }

        @if (store.guidersList().length) {
          @for (g of store.guidersList(); track g.instance) {
            <app-guider-dashboard [guider]="g"></app-guider-dashboard>
          }
        } @else if (nats.isConnected()) {
          <div class="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            no guiders discovered yet — listening on
            <code class="text-zinc-300 mx-1">svc.status.guiding_svc.guider.&gt;</code>
            for active service instances
          </div>
        } @else {
          <div class="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            not connected. open <button class="underline text-zinc-300" (click)="connectionOpen.set(true)">connection</button> to set the NATS URL.
          </div>
        }
      </main>

      @if (shortcutsOpen()) {
        <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-40"
             (click)="shortcutsOpen.set(false)">
          <div class="rounded-lg bg-zinc-900 border border-zinc-700 p-6 max-w-lg w-full"
               (click)="$event.stopPropagation()">
            <div class="flex items-center justify-between mb-3">
              <h2 class="font-semibold">Help — controls</h2>
              <button class="text-zinc-500 hover:text-zinc-200"
                      (click)="shortcutsOpen.set(false)">✕</button>
            </div>

            <h3 class="text-[11px] uppercase tracking-wider text-zinc-500 mt-2 mb-1">Frame view (mouse)</h3>
            <table class="w-full text-sm font-mono mb-3">
              <tbody class="text-zinc-300">
                @for (row of mouseShortcuts; track row.key) {
                  <tr>
                    <td class="py-1 pr-3 text-emerald-400 whitespace-nowrap">{{ row.key }}</td>
                    <td class="text-zinc-400">{{ row.desc }}</td>
                  </tr>
                }
              </tbody>
            </table>

            <h3 class="text-[11px] uppercase tracking-wider text-zinc-500 mt-2 mb-1">Keyboard</h3>
            <table class="w-full text-sm font-mono">
              <tbody class="text-zinc-300">
                @for (row of shortcuts; track row.key) {
                  <tr>
                    <td class="py-1 pr-3 text-emerald-400 whitespace-nowrap">{{ row.key }}</td>
                    <td class="text-zinc-400">{{ row.desc }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>
  `,
})
export class AppComponent implements OnInit {
  nats = inject(NatsService);
  store = inject(GuiderStore);

  connectionOpen = signal<boolean>(true);
  shortcutsOpen = signal<boolean>(false);

  /** True after the auto-collapse fires once. Without this, the effect
   *  would re-collapse the dialog every time the user opens it. */
  private autoCollapsed = false;

  /** Pulse duration used by keyboard shortcuts. Independent of pad UI for
   *  now (could share a service later if multiple dashboards). */
  pulseDurationMs = signal<number>(500);

  /** Arrow-key step size for pixel-mode arrows. Independent of pulse-pad
   *  px input so the keyboard can have its own preferred step. Number-keys
   *  1-4 still rebind ms-mode duration, but most operators will live in px
   *  mode after we made it default. */
  arrowStepPx = signal<number>(30);

  readonly shortcuts: { key: string; desc: string }[] = [
    { key: '?',         desc: 'toggle this panel' },
    { key: '↑ ↓ ← →',  desc: 'pulse N / S / W / E (current duration)' },
    { key: '1 / 2 / 3 / 4', desc: 'pulse duration → 200 / 500 / 1000 / 2000 ms' },
    { key: 'g',         desc: 'mode → guiding' },
    { key: 'm',         desc: 'mode → monitoring' },
    { key: 'o',         desc: 'mode → off' },
    { key: 'r',         desc: 're-acquire (force wide-search around target)' },
    { key: 'h',         desc: 'reticle home (restore to camera-config default)' },
    { key: '+ / -',     desc: 'zoom in / out (frame)' },
    { key: '0',         desc: 'reset zoom (1:1)' },
    { key: 'd',         desc: 'toggle detection-candidates overlay' },
    { key: 'tab / ⇧tab', desc: 'cycle lock through candidates (next / prev)' },
    { key: 'esc',       desc: 'close panels' },
  ];

  readonly mouseShortcuts: { key: string; desc: string }[] = [
    { key: 'left-click',  desc: 'lock onto a star near click — narrow search refines to peak; mount untouched' },
    { key: 'right-click', desc: 'move target reticle (central_point) — rare admin op, forces wide-search' },
    { key: 'wheel',       desc: 'zoom (cursor stays under pointer)' },
  ];

  constructor() {
    // Auto-collapse the connect dialog once a guider has appeared — the
    // operator generally wants the maximum frame area while observing.
    // Only fires once: re-opening the dialog manually doesn't fight the
    // effect.
    effect(() => {
      if (
        !this.autoCollapsed &&
        this.store.guidersList().length > 0 &&
        this.nats.isConnected()
      ) {
        this.autoCollapsed = true;
        this.connectionOpen.set(false);
      }
    });
  }

  ngOnInit(): void {
    this.nats.connect(this.nats.serverUrl())
      .catch(e => console.warn('[ocabox-guider] initial connect failed:', e?.message ?? e));
  }

  // Keyboard shortcuts — wired at the document level so the user doesn't
  // need to focus a particular widget.
  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    // Don't steal keystrokes from inputs.
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const dashboard = this.firstDashboard();

    switch (ev.key) {
      case '?':
        this.shortcutsOpen.update(v => !v);
        ev.preventDefault();
        return;
      case 'Escape':
        this.shortcutsOpen.set(false);
        return;
      // Arrow keys move the star in screen-axis direction. Default
      // behaviour uses pixel-mode (server inverts the calibrated
      // Jacobian) — same intuition regardless of per-camera transpose.
      // Step size from the px-pad signal so changing it in the UI
      // also changes the keyboard step.
      case 'ArrowUp':
        dashboard?.manualPulsePx({ dx_px: 0, dy_px: -this.arrowStepPx() });
        ev.preventDefault(); return;
      case 'ArrowDown':
        dashboard?.manualPulsePx({ dx_px: 0, dy_px: this.arrowStepPx() });
        ev.preventDefault(); return;
      case 'ArrowRight':
        dashboard?.manualPulsePx({ dx_px: this.arrowStepPx(), dy_px: 0 });
        ev.preventDefault(); return;
      case 'ArrowLeft':
        dashboard?.manualPulsePx({ dx_px: -this.arrowStepPx(), dy_px: 0 });
        ev.preventDefault(); return;
      case '1': this.pulseDurationMs.set(200); return;
      case '2': this.pulseDurationMs.set(500); return;
      case '3': this.pulseDurationMs.set(1000); return;
      case '4': this.pulseDurationMs.set(2000); return;
      case 'g': dashboard?.setMode('guiding'); return;
      case 'm': dashboard?.setMode('monitoring'); return;
      case 'o': dashboard?.setMode('off'); return;
      case 'r': dashboard?.acquire(); return;
      case 'h': dashboard?.reticleHome(); return;
      case '+': case '=': dashboard?.zoomIn(); ev.preventDefault(); return;
      case '-': case '_': dashboard?.zoomOut(); ev.preventDefault(); return;
      case '0': dashboard?.zoomHome(); ev.preventDefault(); return;
      case 'd': dashboard?.toggleCandidates(); return;
      case 'Tab':
        dashboard?.cycleCandidate(ev.shiftKey ? -1 : +1);
        ev.preventDefault(); return;
    }
  }

  /** First rendered dashboard. FL2 only ever has one guider per service
   *  instance, so a "currently focused" notion isn't needed yet — when
   *  multi-instance lands the shortcuts will need to scope to one. */
  private dashboards = viewChildren(GuiderDashboardComponent);

  private firstDashboard(): GuiderDashboardComponent | null {
    const list = this.dashboards();
    return list.length > 0 ? list[0] : null;
  }
}
