# Tesla Android Web Frontend (HTML + JavaScript)

This directory contains the new JavaScript-based HTML frontend for Tesla Android.

It is intended to replace the remaining Flutter-side frontend logic with a modular web implementation while preserving the existing Tesla Android backend APIs, websocket transport, and UX behavior.

## Purpose

- Provide a standalone web frontend for Tesla Android display/touchscreen/control flows.
- Keep feature parity with the Flutter frontend where possible.
- Maintain compatibility with existing backend services on `device.teslaandroid.com`.

## Tech Stack

- Plain HTML/CSS/JavaScript (no framework runtime).
- Modular feature-oriented JS structure.
- WebSocket transport for display/audio/gps/touchscreen.
- Multiple display renderers:
  - Motion JPEG
  - h264 (WebCodecs)
  - h264 (legacy Broadway)

## Backend Integration

The frontend currently targets Tesla Android production endpoints:

- API base: `https://device.teslaandroid.com/api`
- WebSockets: `wss://device.teslaandroid.com/sockets/*`

These values are defined in `js/core/shared.js`.

## Running Locally

Use an HTTP server (not `file://`) so workers, modules, and websocket behavior work correctly.

Example:

```bash
php -S 0.0.0.0:8000
```

Then open:

`http://localhost:8000/index.html`

## Browser microphone

The Audio settings include **Microphone (browser)**, enabled by default and saved
locally as `ta.mic.enabled`. Starting audio requests microphone permission from
the user gesture. Disabling the toggle, stopping audio or leaving the page stops
capture. Status shows off, waiting permission, active or denied (also used when
capture is unsupported). Denied access does not affect playback, display or touch.
Capture requires a secure context (HTTPS or localhost), `getUserMedia` and
AudioWorklet. The backend feature switch
`persist.tesla-android.browser_mic.is_enabled` also defaults to true.

Microphone data reuses the playback WebSocket; no new endpoint is needed. Binary
client-to-server messages are raw signed 16-bit little-endian mono PCM at 48000 Hz,
normally 960 samples / 1920 bytes (20 ms). Receivers must accept any even length.
Text messages are `{"type":"mic","state":"start"}` and
`{"type":"mic","state":"stop"}`; receivers should discard buffered audio on stop.
Capture is resampled when necessary, never monitored locally, and dropped rather
than queued when disconnected or backpressured (at most about 200 ms buffered).

Cabin microphone availability on Tesla firmware 2026.26+, its permission UX and
end-to-end Android recording require verification on the vehicle with the matching
relay and AudioFlinger changes. Camera restrictions do not establish microphone
availability while driving.
