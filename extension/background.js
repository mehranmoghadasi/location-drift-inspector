/**
 * background.js — MV3 service worker. Deliberately small:
 *   - opens the dashboard once after install so the first step (importing the
 *     Business Profile spreadsheet) is obvious;
 *   - sets the toolbar badge for a tab after the popup has scanned it
 *     (number of fails, or ✓), so the result stays visible after the popup closes.
 *   - draws the toolbar icon from geometry (lib/icon.js), so the unpacked extension
 *     needs no binary image files.
 * No content script runs on pages you have not explicitly scanned.
 */

import { renderIcon } from './lib/icon.js';

function setToolbarIcon() {
  const imageData = {};
  for (const size of [16, 32]) imageData[size] = new ImageData(renderIcon(size), size, size);
  chrome.action.setIcon({ imageData }).catch((err) => console.warn('could not set icon', err));
}

setToolbarIcon();
chrome.runtime.onStartup.addListener(setToolbarIcon);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch((err) => console.warn('could not open dashboard', err));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'badge' || !Number.isInteger(message.tabId)) return false;
  const fails = Number(message.fails) || 0;
  const warns = Number(message.warns) || 0;
  const text = fails > 0 ? String(fails) : warns > 0 ? '!' : '✓';
  const color = fails > 0 ? '#c93a3a' : warns > 0 ? '#a86600' : '#1f8f4e';
  Promise.all([
    chrome.action.setBadgeText({ tabId: message.tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId: message.tabId, color }),
  ])
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});
