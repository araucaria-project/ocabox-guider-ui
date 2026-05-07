import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NatsService } from '../services/nats.service';
import { GuiderStore } from '../services/guider.store';

@Component({
  selector: 'app-connect-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div class="flex items-center justify-between">
        <div class="font-semibold text-sm text-zinc-200">Connection</div>
        <span class="inline-flex items-center gap-1 text-xs">
          <span class="h-2 w-2 rounded-full"
                [class.bg-emerald-500]="nats.isConnected()"
                [class.bg-zinc-600]="!nats.isConnected() && !nats.isConnecting()"
                [class.bg-amber-500]="nats.isConnecting()"></span>
          <span class="text-zinc-400">
            {{ nats.isConnected() ? 'connected' : nats.isConnecting() ? 'connecting…' : 'offline' }}
          </span>
        </span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="text-xs space-y-1">
          <span class="text-zinc-400">NATS WebSocket URL</span>
          <input class="block w-full rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-zinc-100"
                 [ngModel]="natsUrl()"
                 (ngModelChange)="natsUrl.set($event)"
                 placeholder="ws://192.168.7.38:9222">
        </label>
        <label class="text-xs space-y-1">
          <span class="text-zinc-400">Thumbnail HTTP base</span>
          <input class="block w-full rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-zinc-100"
                 [ngModel]="thumbBase()"
                 (ngModelChange)="thumbBase.set($event)"
                 placeholder="http://192.168.7.38:8080">
        </label>
      </div>

      <div class="text-xs text-zinc-500">
        <span>Thumbnail-server hint: serve the guider's </span>
        <code class="text-zinc-300">output_dir</code>
        <span> as static files (e.g. </span>
        <code class="text-zinc-300">caddy file-server --root /tmp/guider_thumbs --listen :8080</code>
        <span>). Path prefix </span>
        <code class="text-zinc-300">{{ store.thumbnailPathPrefix() }}</code>
        <span> is stripped from the file path before fetching.</span>
      </div>

      <div class="flex gap-2">
        <button class="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1.5 text-sm font-medium"
                [disabled]="nats.isConnecting()"
                (click)="apply()">
          {{ nats.isConnected() ? 'Reconnect' : 'Connect' }}
        </button>
        <button class="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-sm"
                [disabled]="!nats.isConnected()"
                (click)="disconnect()">
          Disconnect
        </button>
      </div>

      @if (nats.connectionError(); as err) {
        <div class="text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded p-2">{{ err }}</div>
      }
    </div>
  `,
})
export class ConnectDialogComponent {
  nats = inject(NatsService);
  store = inject(GuiderStore);

  natsUrl = signal(this.nats.serverUrl());
  thumbBase = signal(this.store.thumbnailHttpBase());

  apply(): void {
    this.store.setThumbnailHttpBase(this.thumbBase());
    this.nats.connect(this.natsUrl()).catch(() => { /* error already on signal */ });
  }

  disconnect(): void {
    this.nats.disconnect();
  }
}
