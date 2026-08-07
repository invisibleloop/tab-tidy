import { saveGroupRules, getApplyIntervalMinutes, saveApplyIntervalMinutes } from '../shared/storage.js';
import { applyGroupRules, reconcileAutoGroups } from './group-manager.js';
import { ALARM_NAME } from '../shared/constants.js';

async function startAlarm() {
  const periodInMinutes = await getApplyIntervalMinutes();
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes });
  });
}

export function registerListeners() {
  // Reapply rules periodically so newly opened tabs get grouped
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
      await applyGroupRules({ automatic: true });
    }
  });

  // On startup, reconcile state
  chrome.runtime.onStartup.addListener(async () => {
    await reconcileAutoGroups();
    startAlarm();
  });

  // On install / update
  chrome.runtime.onInstalled.addListener(async () => {
    startAlarm();
  });

  // Handle messages from popup
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch((err) => {
      console.error('Message handler error', err);
      sendResponse({ error: err.message });
    });
    return true;
  });
}

async function handleMessage(message) {
  switch (message.type) {
    case 'SAVE_GROUP_RULES':
      await saveGroupRules(message.rules);
      return { ok: true };
    case 'APPLY_GROUP_RULES':
      await applyGroupRules();
      return { ok: true };
    case 'SAVE_APPLY_INTERVAL':
      await saveApplyIntervalMinutes(message.minutes);
      await startAlarm();
      return { ok: true };
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}
