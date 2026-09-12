# PVT-RD — PVT Remote Display

A standalone Manifest V3 browser extension for Procedural Visualizer Tool.
The toolbar action opens/focuses a pinned extension tab that owns WebRTC.
Keep the tab open while connected; the service worker never owns media streams.

## Build and load

Requires Node.js 22+ and pnpm (the exact version is pinned in package.json).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

- Chrome: load `dist/chrome` as an unpacked extension at `chrome://extensions`.
- Firefox: temporarily load `dist/firefox/manifest.json` at `about:debugging`.
- Safari: convert `dist/safari` with Xcode's Safari Web Extension converter,
  then sign and install the resulting application. Browser store publication
  and Safari signing are not included in the source build.

## Pair with PVT

PVT needs the desktop Remotes integration and optional `pvt-remote` Python worker.
From the PVT checkout, `python3 scripts/install-remote-worker.py` installs that
worker in a private environment without enabling networking.

1. Open **Hosts & settings** and export `.pvtremote`.
2. In PVT's **Settings → Networking & Remotes**, import the remote profile.
3. Enable networking, choose the active control remote if applicable, and Apply.
4. Export `.pvthost` from PVT, import it here, select the host, and Connect.

Receives PVT’s real stage video and audio over WebRTC. Audio starts muted; select Enable audio to hear it. Full screen and host background controls are available. Multiple paired display identities can receive output simultaneously.

The host selector supports multiple profiles. Editing profiles changes labels
and endpoints without replacing pinned keys. Profile removal is immediate.
Browser sync is optional, inspectable and clearable. Only public host profiles
and your sync preference are synced; private remote keys remain local.
Reinstallation restores previously synced hosts but creates a new remote identity,
which must be imported in PVT again. Disabling sync keeps profiles local.

LAN connections use the exported host's `.local`/IPv4 endpoints. Internet
connections need a deployed PVT signaling relay and suitable host STUN/TURN
configuration. No signaling service is assumed or automatically provisioned.

## Shared code and verification

`vendor/pvt-remote-client` is generated from the PVT repository's `remote/client`.
`SOURCE.json` identifies the source and file hashes. Make shared changes there,
then run `python3 scripts/sync-remote-clients.py` and `--check` from PVT. Both
extension repositories remain independently buildable without a sibling checkout.
Do not hand-maintain a second transport or security protocol here.

See the PVT repository's `remote/README.md` for protocol details, host setup,
media limits and end-to-end test commands. CI runs unit tests and produces all
three browser builds. Chromium runtime tests use real unpacked extensions,
mutual cryptography, a real WebRTC encoder/decoder and an isolated browser profile.
Firefox/Safari runtime certification and production NAT/TURN testing remain
separate validation gates.

License: GPL-3.0; see LICENSE.
