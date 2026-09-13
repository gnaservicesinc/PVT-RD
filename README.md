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

PVT packages include the transport. There is no separate runtime setup.

1. In **Hosts & settings**, save `.pvtremote`.
2. Import it in PVT's **Settings → Networking & Remotes**.
3. Save `.pvthost` from PVT and open it here, then choose **Save changes**. Connection starts automatically.

Keep PVT running and the remote tab open. Pairings and the selected PVT survive
restarts. Temporary interruptions reconnect automatically. Disconnect pauses
connections until Connect is selected again.

Receives PVT’s real stage video and audio over WebRTC. Audio starts muted; select Enable audio to hear it. Full screen and host background controls are available. Multiple paired display identities can receive output simultaneously.

The host selector supports multiple profiles. Editing profiles changes labels
without replacing pinned keys. Names, removals and sync preferences are drafts until
**Save changes**. Done, Escape and clicking outside settings prompt to save or
discard pending changes; closing or reloading the tab warns while changes remain.
Saving errors keep the draft available to retry.
Browser sync is optional, inspectable and clearable. Only public host profiles
and your sync preference are synced; private remote keys remain local.
Reinstallation restores previously synced hosts but creates a new remote identity,
which must be imported in PVT again. Disabling sync keeps profiles local.

Same-machine connections work without an external network. Local-network
connections use automatic discovery from the saved pairing. PVT and its remotes are designed to share a network; no hosted service or
manual network configuration is required.

## Version 0.2.0 interface

Hosts & settings opens as a focused dialog over the workspace. Pairing steps,
named hosts and browser sync share one Save changes action. The footer displays
the installed extension version.

The live stage fits the window without stretching its video. Audio state and
fullscreen controls stay together beneath the stage. Opening settings retains
the connected video element and playback.

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
