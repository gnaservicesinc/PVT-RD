import browser from 'webextension-polyfill';
// A dedicated pinned extension tab owns WebRTC and media, never the MV3 worker.
// This lifecycle is supported in Chrome, Firefox and Safari without offscreen API
// assumptions or attempts to serialize MediaStreams through runtime messaging.
let opening;
browser.action.onClicked.addListener(() => {
  opening ??= (async () => {
    const url = browser.runtime.getURL('index.html');
    const tabs = await browser.tabs.query({url});
    if (tabs[0]) {
      await browser.tabs.update(tabs[0].id, {active: true, pinned: true});
      await browser.windows.update(tabs[0].windowId, {focused: true});
    } else await browser.tabs.create({url, active: true, pinned: true});
  })().finally(() => { opening = undefined; });
});
