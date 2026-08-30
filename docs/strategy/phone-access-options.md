# Phone access options

Status: decision proposal for the assisted student pilot and later public
self-service. This assessment is based on `origin/develop` at
`2320edee2462bc4b47579160f7d7bf4cd77041fb` on 30 August 2026. It does not
authorise a hosted relay, infrastructure deployment, certificate purchase, or
public release.

## Decision

Use the existing private Tailscale path for the assisted 3 to 5 student pilot,
but move its diagnosis and recovery into Tovi. Do not describe it as the final
public phone experience.

Develop the existing iPhone companion as the next client surface, initially on
the same Tailscale transport. After it passes physical iPhone testing, add
certificate-pinned same-Wi-Fi pairing to the companion. This is the shortest
credible route to a no-Tailscale experience while the Mac and iPhone are on the
same network.

Treat an end-to-end encrypted hosted relay as a later public self-service
option. It would remove the same-network requirement, but it creates a new
security protocol and an always-on service. Do not build it until the pilot has
proved that phone use is important enough to justify that cost.

## The options are two different decisions

The four options are not direct substitutes.

| Decision | Choices |
| --- | --- |
| How the phone reaches the host | Same Wi-Fi, an integrated private network, or a hosted relay |
| What runs on the phone | Safari or the Home Screen web app, or the native iPhone companion |

The native companion still needs a transport. It can use Tailscale now,
same-Wi-Fi pairing later, and a relay in the future without replacing the Tovi
reply interface.

## Verified repository behaviour

The following is verified from the repository at the baseline above. It is not
a claim that the full journey has passed on a physical iPhone.

- The shared launcher creates a random private access token, writes a new token
  file outside the app bundle with mode `0600`, and starts an authenticated
  proxy for the dashboard. The dashboard and runner remain on loopback. The
  pairing URL exchanges the token for an HTTP-only, same-site cookie. See
  [`phone-access.cjs`](../../apps/desktop/phone-access.cjs) and the
  [phone-access tests](../../tests/desktop-phone-access.test.mjs).
- The same-Wi-Fi fallback is authenticated HTTP. It supports reading and
  typing, but it does not encrypt traffic on the local network and it cannot
  provide full browser dictation. Sensitive browser capabilities such as the
  microphone are deliberately restricted to
  [secure contexts](https://www.w3.org/TR/secure-contexts/). Tovi already labels
  dictation as unavailable on the HTTP path.
- When Tailscale is online with MagicDNS and HTTPS enabled, the launcher uses a
  dedicated Tailscale Serve port and proxies it to the authenticated Tovi phone
  proxy. It does not enable Funnel. Tailscale documents that
  [Serve is private to the tailnet and obeys its access rules](https://tailscale.com/docs/features/tailscale-serve),
  while its data plane is
  [end-to-end encrypted between devices](https://tailscale.com/docs/concepts/tailscale-encryption).
- The HTTPS machine name is placed in public certificate-transparency logs.
  Tailscale documents this disclosure and recommends using a non-sensitive
  machine name in its
  [HTTPS certificate guidance](https://tailscale.com/docs/how-to/set-up-https-certificates).
- The token is stable across launches. There is no in-app device list, token
  rotation, or access revocation action. Quitting Tovi closes the proxy and
  removes its selected Serve mapping, but reopening it restores access for a
  phone that still holds the cookie.
- An iPhone companion already exists under [`apps/ios`](../../apps/ios). It
  embeds the existing web interface and sends user-triggered dictation commands
  to a native `AVAudioSession` recorder. The recorder writes AAC as it records,
  handles interruptions, and returns audio to the existing editable review
  flow. It contains no message-send path. Apple limits background execution to
  declared modes and recommends using them sparingly, as described in
  [Configuring background execution modes](https://developer.apple.com/documentation/Xcode/configuring-background-execution-modes).
- The companion is an implementation scaffold, not a distributed pilot app.
  It has source-level regression tests, but its documented physical iPhone
  check has not been established by those tests. It accepts any HTTPS host and
  stores the full pairing URL in `AppStorage`, rather than keeping the access
  credential in Keychain. There is no TestFlight or App Store delivery path in
  the repository.

## Comparison

### Secure same-Wi-Fi pairing

**Security and privacy.** This can keep message data entirely between the Mac
and phone, but only if the connection is encrypted and the phone authenticates
the specific Mac it paired with. The current token-protected HTTP fallback is
not that final design. A native client can pin a host public key or certificate
fingerprint transferred in a one-time QR pairing. A browser requires a trusted
HTTPS origin before it exposes the microphone and other protected APIs, so a
self-signed certificate or a launcher-generated root certificate would bring
back expert setup.

**Implementation cost.** Medium to high. Tovi would need local discovery,
one-time pairing, host identity generation and rotation, encrypted transport,
a paired-device list, revocation, reconnect behaviour, and truthful handling
of guest Wi-Fi or client isolation. Apple provides Bonjour for
[local service discovery](https://developer.apple.com/bonjour/) and requires
native apps using local discovery to explain and request
[local-network access](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

**Operating cost.** Low infrastructure cost because there is no relay. Support
cost is less predictable because home, university, guest, and managed networks
can block peer discovery or direct device traffic.

**Local-first impact.** Strongest of the four paths. The connection and data
remain local. The Mac must still be awake and running Tovi.

**Quality of experience.** Very good after one QR scan on an ordinary home
network. It fails outside the local network and can fail on institutional
networks even when both devices show the same Wi-Fi name.

**Fit.** Worth building after the native companion is physically proven. Do
not make a browser-first same-Wi-Fi HTTPS system for the pilot.

### More integrated private-network setup

**Security and privacy.** This keeps the existing Tailscale encrypted path,
tailnet access controls, and Tovi's separate access token. Device approval can
prevent a new device from exchanging traffic until an administrator approves
it, and Tailscale supports later revocation. See
[Device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval).
Tailscale operates the identity and coordination layer, but Tovi message
content is not moved into a Tovi-hosted service.

**Implementation cost.** Low to medium because the transport already works.
The missing work is an in-app setup and recovery assistant that distinguishes
Tailscale missing, signed out, offline, waiting for approval, wrong tailnet,
MagicDNS disabled, HTTPS disabled, Serve failed, host asleep, and token
revoked. Each state needs one useful next action.

**Operating cost.** Low for an assisted personal pilot. Tailscale's current
[Personal plan is free for non-commercial personal use](https://tailscale.com/pricing),
but a public commercial product must confirm the correct plan or product
agreement rather than assuming that free tier applies.

**Local-first impact.** The database, platform sessions, runner, and message
actions stay on the Mac. Connectivity depends on Tailscale's client and
coordination service, even though device traffic remains encrypted.

**Quality of experience.** Good after setup and works away from the Mac's
local network. First use still asks a student to install another app, accept a
VPN configuration, and sign in through an identity provider, which is the
current quality-of-life problem documented by Tailscale's own
[iOS installation steps](https://tailscale.com/docs/install/ios).

**Fit.** Best immediate assisted-pilot path because it improves an implemented
and tested boundary without creating a new transport.

### Native mobile companion

**Security and privacy.** A companion is not a network security design. It
inherits the security of Tailscale, same-Wi-Fi pairing, or the relay beneath
it. It can improve credential storage, certificate pinning, local-network
permission handling, microphone control, background recording, and explicit
device revocation. Apple App Transport Security requires secure connections
using reliable TLS by default, as described in
[Preventing insecure network connections](https://developer.apple.com/documentation/Security/preventing-insecure-network-connections).

**Implementation cost.** Medium because the SwiftUI and native dictation
bridge already exist, but production work remains. That includes Keychain
storage, strict host validation or certificate pinning, deep-link pairing,
navigation and recovery, signing, release automation, physical-device tests,
and a separate Android decision.

**Operating cost.** Apple distribution needs an active Developer Program
membership, currently
[99 USD per membership year](https://developer.apple.com/programs/whats-included/),
plus ongoing iOS release and support work.

**Local-first impact.** Strong when combined with same-Wi-Fi or Tailscale. The
companion can remain a view and capture client while all durable Tovi state and
external message actions stay on the Mac.

**Quality of experience.** Best iPhone client option. It can keep dictation
behaviour under Tovi's control, store pairing state more safely, and diagnose
local permissions directly. TestFlight still asks testers to install the
TestFlight app and accept an invitation. Apple notes that an external beta's
first build requires review and that builds expire after 90 days in its
[TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview).

**Fit.** The best next client investment if physical testing confirms the
existing scaffold. It should use Tailscale first, then add same-Wi-Fi pairing.

### End-to-end encrypted hosted relay

**Security and privacy.** A public relay can be designed so it stores and
forwards only ciphertext, but `wss` alone is not end-to-end encryption because
TLS ends at the relay. The Mac and phone need authenticated device keys and
application-level encryption. The protocol also needs replay and ordering
protection, device removal, key rotation, recovery after compromise, and a
clear rule for whether ciphertext is queued while the Mac is offline.

[WebSocket over TLS](https://datatracker.ietf.org/doc/html/rfc6455) is a
suitable bidirectional transport, not the complete security design. Standards
such as [HPKE](https://datatracker.ietf.org/doc/html/rfc9180) and the
[Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) provide building
blocks. [Messaging Layer Security](https://datatracker.ietf.org/doc/html/rfc9420)
shows the stronger model in which an untrusted delivery service can route
encrypted application messages but can still delay, drop, and observe
metadata. Tovi does not need to adopt MLS automatically, but it does need an
equivalent written threat model and an independently reviewed protocol before
real conversations use a relay.

**Implementation cost.** Very high. It adds device enrollment, a durable
connection protocol, relay deployment, version negotiation, rate limits,
abuse controls, outage recovery, observability that never logs private message
content, and security review. Offline delivery adds encrypted storage and
retention rules.

**Operating cost.** Highest and ongoing. Even a stateless online-only relay
needs hosting, bandwidth, monitoring, incident response, certificate renewal,
and capacity planning.

**Local-first impact.** The Mac can remain the source of truth and the only
device that performs platform actions, but phone availability now depends on
Tovi infrastructure. The relay learns connection metadata such as IP address,
timing, device identifiers, and ciphertext size unless the protocol
deliberately reduces it.

**Quality of experience.** Best reachability. A student can pair once and use
Tovi across Wi-Fi and mobile data without understanding private networks. It
also creates a new failure mode outside both devices and raises the public
promise from a local app to an operated service.

**Fit.** A later public self-service option, not an assisted-pilot task.

## Summary matrix

| Option | Security and privacy | Implementation cost | Operating cost | Local-first | User experience | Recommended stage |
| --- | --- | --- | --- | --- | --- | --- |
| Secure same-Wi-Fi | Strong only with pinned TLS and real device revocation. Current HTTP is not sufficient. | Medium to high | Low infrastructure, variable support | Strongest | Simple at home, unreliable on isolated networks, local only | After native companion proof |
| Integrated Tailscale | Strong implemented encrypted transport plus Tovi token. Vendor identity and coordination remain. | Low to medium | Low for assisted personal pilot, commercial terms unresolved | Strong | Extra app, VPN prompt, identity login, then works across networks | Assisted pilot now |
| Native companion | Depends on the transport. Enables Keychain, pinning, native permissions, and background capture. | Medium from existing scaffold | Apple membership and ongoing mobile releases | Strong with local transport | Best iPhone interaction, separate install and review path | Next client phase |
| End-to-end encrypted relay | Potentially strong, but only after a reviewed application-level protocol. Metadata remains. | Very high | Highest and continuous | Partial | Best reachability and least network knowledge | Later public option |

## Phased approach

### Phase 1: assisted student pilot

1. Keep Tailscale Serve as the only supported full phone path. Keep the
   same-Wi-Fi HTTP link as a clearly limited read-and-type fallback on a
   private network.
2. Give each student their own tailnet with their Mac and phone. Do not place
   all pilot users and hosts in one shared tailnet.
3. Replace the current instruction block with an in-app readiness assistant.
   Show host status, Tailscale installation, sign-in, device approval,
   MagicDNS, HTTPS, Serve health, QR pairing, microphone readiness, and one
   exact repair action for the first failing state.
4. Add an in-app `Revoke phone access` action that rotates the Tovi token and
   closes existing phone sessions. Quitting the app is not sufficient
   revocation because the token and cookie survive the next launch.
5. Physically test Safari and the Home Screen app for setup, microphone,
   keyboard, safe area, suspension, resume, host sleep, host offline, and
   recovery. Do not call phone access pilot-ready from automated tests alone.

This phase keeps the transport that already exists and directly removes the
operator knowledge currently hidden in the install guide.

### Phase 2: iPhone companion through TestFlight

1. Complete the existing physical dictation checklist before distribution.
2. Move the pairing credential out of `AppStorage` and into Keychain.
3. Restrict the initial companion to the verified Tailscale HTTPS origin, or
   pin the paired host identity. Do not accept arbitrary HTTPS hosts as a
   production trust decision.
4. Add deep-link or QR handoff so the student never copies the private URL.
5. Distribute to the pilot through TestFlight only after signing, review, and
   release authority are available.

This phase improves iPhone recording, suspension, and recovery without mixing
mobile client work with a new network protocol.

### Phase 3: no-Tailscale access on the same Wi-Fi

1. Add Bonjour discovery to the Mac host and native companion.
2. Pair with a short-lived QR that carries a one-time secret and the Mac's
   public-key fingerprint.
3. Use encrypted, mutually authenticated transport with the paired host
   identity pinned on the phone.
4. Add a paired-device list, explicit revocation, host rename handling, and a
   truthful state for guest Wi-Fi or client isolation.
5. Keep Tailscale as the remote-access fallback.

This delivers the first real no-Tailscale path without asking Safari to trust
a locally generated certificate.

### Phase 4: public access away from the local network

Before implementation, write and review a relay threat model covering key
generation, QR enrollment, metadata, replay, device loss, revocation, version
skew, rate limiting, offline storage, logging, and incident response. Prototype
an online-only relay first so the server retains no queued conversation data.
Add offline encrypted queues only if user evidence shows they are necessary.

This phase requires explicit approval because it changes Tovi from a local app
with optional vendor connectivity into an operated online service.

## Release gates

### Assisted pilot

Phone access can pass the assisted-pilot gate when:

- the supported path is stated as Tailscale HTTPS, not generic phone access,
- a student can follow the in-app diagnosis without Terminal,
- phone access can be revoked from Tovi,
- host offline, host asleep, permission denied, and authentication expiry have
  truthful recovery states,
- Safari or the chosen companion passes the physical golden journey, and
- no private URL, token, message content, transcript, or screenshot enters
  logs or defect evidence.

### Public self-service

The current phone path does not pass the public-self-service gate. That gate
needs either the native same-Wi-Fi path for local use or a reviewed encrypted
relay for use across networks, plus consumer distribution, physical iPhone and
Android scope decisions, revocation, recovery, and a clear supported-platform
promise.
