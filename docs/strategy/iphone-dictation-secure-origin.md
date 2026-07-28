# iPhone dictation secure-origin decision

## Decision

Tovi uses Tailscale Serve as the preferred phone origin. The launcher starts a
private HTTPS reverse proxy on a dedicated Tailscale port and points it at
Tovi's existing authenticated phone proxy on loopback.

The request path is:

`iPhone Safari or Home Screen app -> private Tailscale HTTPS -> authenticated Tovi phone proxy -> loopback dashboard -> loopback runner`

The private access token remains required. Tailscale access does not replace
Tovi authentication. The dashboard and runner continue to listen on loopback,
and Tovi never enables Tailscale Funnel.

## Why this option

Browser microphone capture requires a secure context. A raw private IPv4 HTTP
address cannot provide one.

- A launcher-generated root certificate would require every pilot iPhone to
  install a profile and manually grant system-wide TLS trust. Apple recommends
  managed deployment for this, so it is not appropriate for an unmanaged
  student pilot.
- A public relay tunnel would put a third-party relay in the application
  request path and expand exposure beyond the private device network.
- HTML audio capture can invoke an iPhone recorder, but it does not provide
  Tovi's in-page recording state and Stop control. It is not a substitute for
  the requested experience.
- Tailscale Serve provides a browser-trusted HTTPS certificate, private
  tailnet access controls, and encrypted device-to-device transport. It can
  proxy a loopback service without exposing the runner to the LAN.

## Lifecycle and coexistence

The launcher checks that Tailscale is online, MagicDNS is active, and HTTPS is
enabled. It chooses the first free port from 3111 through 3120. Existing Serve
ports are not replaced. Tovi removes only its selected HTTPS mapping during
normal shutdown.

If secure setup is unavailable, the existing authenticated HTTP Wi-Fi link
continues to support reading and typing. Dictation is disabled with a recovery
message that directs the user to the HTTPS QR code. There is no keyboard
dictation fallback behind a Dictate label.

## Audio and permission boundaries

The browser requests `{ audio: ..., video: false }` from the page's own
`navigator.mediaDevices`. It rejects any stream containing a video track.
Safari MP4/AAC and Chromium WebM/Opus recordings are normalized for the runner.
Tracks stop on Stop, Cancel, recorder failure, page navigation, and component
unmount.

The upload route accepts known audio MIME types, sanitizes filenames, uses a
per-request temporary directory, and removes that directory after every
completed or failed transcription attempt. Transcripts and formatted messages
remain editable. No recording or review action sends a message automatically.

## Operational disclosure

Enabling Tailscale HTTPS publishes the Mac's Tailscale DNS name to public
certificate-transparency logs. It does not make the service public. Pilot
operators should choose a non-sensitive Tailscale machine name before enabling
HTTPS.
