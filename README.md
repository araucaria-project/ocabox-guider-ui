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

## Status (FL2 — first-light validated)

Sky-tested 2026-05-07 against the jk15 BESO spectrograph guider. Mode A
(hold star where it is) converges with calibrated Jacobian; Mode B
(drop star into fibre) has MVP plumbing.

### Live dashboard
- Discovery: live list of guiders via `svc.status.guiding_svc.guider.>`
- Frame view with sub-pixel star crosshair, draggable target reticle,
  amber X for ``guide_anchor`` (lock target during guiding), and a
  cyan-circle overlay for FFS detection candidates
- Mouse wheel zoom (cursor stays under pointer); overlays use
  ``vector-effect="non-scaling-stroke"`` so they stay crisp
- Drift chart (rolling) and image-X / Y scatter wind-rose plot, both
  axes match the preview frame (no astronomical relabel — image
  X/Y is the honest coordinate system, RA/Dec mapping per-camera
  lives in the calibrated Jacobian)
- Live RA / Dec / total RMS, FWHM placeholder, lock-state colours
- Camera panel with sparse-overrides (slider committed via Apply) and
  Rich-style display

### Interaction
- **Left-click** — ``lock_at(x, y)``: narrow-search seed; in guiding
  mode also re-anchors ``guide_anchor`` on the picked star (no stray
  pulses dragging the new star to the old anchor)
- **Right-click** — ``acquire_at(x, y)``: move the target reticle
  (admin op, forces wide-search around the new central_point)
- **TAB / Shift-TAB** — cycle ``lock_at`` through detection candidates
- **Drop → reticle button** — Mode B fibre-injection: re-anchor active
  guidance onto ``central_point``
- **Reticle** — selectable style (six designs + 'none' to suppress);
  **home** button + ``h`` shortcut restore to the camera-config default
  (``central_point_default``); markers are hollow at centre so the pixel
  under the reticle / anchor / star ring stays visible at zoom

### Calibration
- Collapsible calibration panel with N/S/E/W probe buttons, results
  table, suggested 2×2 Jacobian YAML
- **Backlash filter**: first probe of every direction is greyed out
  in the table and excluded from the Jacobian estimate (mount gear
  backlash makes that probe ~30-60% smaller than steady-state)
- **Median over surviving probes** — outlier-resistant
- Requires ≥1 surviving probe per axis; recommends ≥2 per direction
  with long pulses (≥1000ms) and long settle (≥2500ms)

### Status / mode
- Top toolbar: off / monitoring / guiding mode buttons, re-acquire,
  drop → reticle, calibrate (FL2.1 placeholder)
- Status bar: mode, acquired y/n, star sub-pixel coords, reticle
  coords, exposure
- Help dialog (``?``) listing keyboard + mouse shortcuts

### Not yet
- Setpoint-vs-actual round-trip indicator (slider committed but no
  visible "this is the live value" badge)
- Mode "center" — explicit toggle for guidance always pulling toward
  the reticle (drop_to_reticle is one-shot equivalent for now)
- Mount-tracking indicator + auto-revert on tracking-off
- FWHM and last-correction display (server-side fields scaffolded,
  not yet emitted)
- Pixel-mode calibration buttons (N/S/E/W → "↑ +30 px" etc.)
- Multi-pipeline UI (store is multi-pipeline ready, dashboard
  surfaces the first one only)
- Auth / per-user permissions
- Mobile layout, E2E tests
