# ocabox-guider-ui

Web UI for the OCM telescope **guiding service** (`ocabox-tcs/services/guiding_svc`).

The UI is a thin client over NATS — it discovers active guider service instances
via the **standard TCS service-status stream** (`<prefix>.status.guiding_svc.guider.>`,
the same stream `tcsctl` reads), then subscribes to per-instance state, events,
journal, and thumbnail-ready streams to render a live dashboard with
click-to-acquire and manual-pulse controls.

There is **no backend in this repo**: the guider service publishes everything
the UI needs over NATS WebSocket, and serves frame thumbnails as static JPEGs
(via any third-party file-server you run alongside it). This separation is by
design — the architecture rule for the guider service is *no embedded HTTP
server*.

## Stack

- Angular 21, standalone components, signals + OnPush
- Tailwind CSS
- `nats.ws` for NATS-over-WebSocket
- No router, no SSR

The scaffold is modelled on
[`mini-web-ocam`](../mini-web-ocam/) — the OCM-wide observatory dashboard.

## Wire format

Subjects (configurable prefix; default `svc`):

| Purpose | Subject | Stream |
|---|---|---|
| Service discovery + health | `svc.status.guiding_svc.guider.<variant>` | JS, last-per-subject |
| Pipeline state | `svc.publish.guider.<instance>.pipeline.<pipe>.state` | JS, last-per-subject |
| Events | `svc.publish.guider.<instance>.pipeline.<pipe>.events` | JS |
| Journal | `svc.publish.guider.<instance>.pipeline.<pipe>.journal` | JS |
| Correction telemetry | `svc.telemetry.guider.<instance>.pipeline.<pipe>.correction` | JS |
| Thumbnail ready | `svc.publish.guider.<instance>.frame.thumbnail.ready` | JS |
| RPCs | `svc.rpc.guider.<instance>.pipeline.<pipe>.v1.<cmd>` | core |

`<variant>` is the TCS variant string (hyphen form, e.g. `jk15-guider_beso`).
`<instance>` is the dot-form NATS path (e.g. `jk15.guider_beso`) — the UI
reads this from `details.metrics.guider.instance` in the status message and
uses it to construct the per-pipeline subjects above.

The status message follows the TCS framework shape (`name`, `status`, `pid`,
`hostname`, `parent`, `details`). Guider-specific metadata sits under
`details.metrics.guider` — added by the guider service via the standard
`monitor.add_metric_cb()` hook, so no TCS base changes are required.

RPC bodies use the **serverish envelope**: `{"data": {...}, "meta": {"message_type": "rpc"}}`.
Bare payloads silently no-op (responder unwraps `data`/`meta`, finds them
missing, hits an empty fast-path). The `NatsService.rpcRequest` helper handles
this automatically.

## Running locally

```bash
npm install
npm start
# → http://localhost:4200
```

In the **Connection** dialog at the top of the page, set:
- **NATS WebSocket URL** — e.g. `ws://192.168.7.38:9222` (the OCM observatory)
- **Thumbnail HTTP base** — see below

## Serving thumbnails

The guider writes JPEGs to disk (configured via `thumbnails.output_dir` in the
service YAML). The UI fetches them over HTTP, so you need a static file server
in front of that directory.

Quickest way (no setup):

```bash
# from the guider service host:
caddy file-server --root /tmp/guider_thumbs --listen :8080 --browse

# or with python (good enough for dev):
cd /tmp/guider_thumbs && python -m http.server 8080
```

Then in the UI's Connection dialog set **Thumbnail HTTP base** to
`http://<service-host>:8080`. The path prefix `/tmp/guider_thumbs` is stripped
from incoming notification paths before fetching, so the resulting URL is
`http://<host>:8080/<instance>/<pipe>/<seq>.jpg` (or `latest.jpg`).

For production: replace caddy with whatever serves the NFS share, or place
nginx in front of an NFS-mounted thumbnail directory. The notification payload
includes the absolute filesystem path; configure the prefix to match.

## Project layout

```
src/
  main.ts                       # bootstrap
  app.component.ts              # shell — header + connect dialog + cards grid
  index.html
  styles.css
  services/
    nats.service.ts             # connect + subscribeJS + rpcRequest, envelope-aware
    guider.store.ts             # discovery + per-guider state, signal-based
  components/
    connect-dialog.component.ts # NATS URL + thumb HTTP base
    guider-card.component.ts    # one card per discovered guider
```

## Status (FL2 dev iteration 1)

What works:
- Discovery: live list of guiders via the standard `svc.status.guiding_svc.guider.>` stream
- Per-guider state display (mode, acquired_pos, FWHM, exp_time, central_point)
- Latest thumbnail rendering with cache-bust + acquired-pos crosshair overlay
- Click-on-image → `acquire_at(x, y)` RPC (sensor-pixel coords)
- Manual pulse buttons (N/S/E/W, configurable duration)
- Mode toggle (off / monitoring / guiding) + acquire trigger
- RPC status feedback under the controls

Not yet:
- Sensor-shape autodetection from the camera (currently hardcoded 1936×1216)
- Live correction telemetry plot
- Multi-pipeline support per instance (the FL1 contract is one pipeline; the
  store is multi-pipeline ready, the card UI surfaces the first one only)
- Auth / per-user permissions
- Mobile-tuned layout
- E2E or unit tests
