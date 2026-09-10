export default defineBackground(() => {
  const KEEP_ALIVE_ALARM = "keep-alive";

  // ---------------------------------------------------------------------------
  // Keep the service worker alive via a repeating alarm.
  // ---------------------------------------------------------------------------
  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
      // No-op — just keeps the worker from being suspended.
    }
  });

  // ---------------------------------------------------------------------------
  // Detect when a Google Meet tab is fully loaded and notify its content script.
  // ---------------------------------------------------------------------------
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (!tab.url?.includes("meet.google.com")) return;

    // Give the content script a moment to initialise before messaging it.
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { action: "MEET_DETECTED" }, () => {
        // Suppress "Could not establish connection" errors when the content
        // script has not yet been injected.
        void chrome.runtime.lastError;
      });
    }, 500);
  });

  // ---------------------------------------------------------------------------
  // Handle messages from content scripts / popup.
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    switch (message?.action) {
      case "MEETING_STARTED":
        console.log(
          "[Background] Meeting started:",
          message.meetingId,
          "URL:",
          message.meetUrl,
        );
        break;

      case "MEETING_ENDED":
        console.log("[Background] Meeting ended:", message.meetingId);
        break;

      case "OPEN_DASHBOARD":
        chrome.tabs.create({ url: chrome.runtime.getURL("/dashboard.html") });
        break;

      default:
        break;
    }

    // Return false to indicate we are NOT sending an async response.
    return false;
  });
});
