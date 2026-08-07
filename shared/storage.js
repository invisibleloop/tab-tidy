import { STORAGE_KEYS, DEFAULT_APPLY_INTERVAL_MINUTES } from './constants.js';

// groupRules: Array<{ id, pattern, name, color, matchType, enabled }>
export async function getGroupRules() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.groupRules);
  return result[STORAGE_KEYS.groupRules] || [];
}

export async function saveGroupRules(rules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.groupRules]: rules });
}

// autoGroups: { [windowId]: { [ruleId]: groupId } }
export async function getAutoGroups() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.autoGroups);
  return result[STORAGE_KEYS.autoGroups] || {};
}

export async function saveAutoGroups(groups) {
  await chrome.storage.local.set({ [STORAGE_KEYS.autoGroups]: groups });
}

// applyIntervalMinutes: number — how often rules are automatically reapplied
export async function getApplyIntervalMinutes() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.applyIntervalMinutes);
  return result[STORAGE_KEYS.applyIntervalMinutes] || DEFAULT_APPLY_INTERVAL_MINUTES;
}

export async function saveApplyIntervalMinutes(minutes) {
  await chrome.storage.local.set({ [STORAGE_KEYS.applyIntervalMinutes]: minutes });
}

// viewingRule: { ruleId, windowId } — which rule's tabs the side panel should show.
// Session-scoped: cleared automatically when the browser closes.
export async function getViewingRule() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.viewingRule);
  return result[STORAGE_KEYS.viewingRule] || null;
}

export async function saveViewingRule(ruleId, windowId) {
  await chrome.storage.session.set({ [STORAGE_KEYS.viewingRule]: { ruleId, windowId } });
}

// compactRulesView: boolean — whether the rules list uses the condensed layout
export async function getCompactRulesView() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.compactRulesView);
  return result[STORAGE_KEYS.compactRulesView] || false;
}

export async function saveCompactRulesView(compact) {
  await chrome.storage.local.set({ [STORAGE_KEYS.compactRulesView]: compact });
}

// theme: 'light' | 'dark' — explicit user choice. Unset until the user
// first toggles it, at which point it follows the OS preference.
export async function getTheme() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.theme);
  return result[STORAGE_KEYS.theme] || 'system';
}

export async function saveTheme(theme) {
  await chrome.storage.local.set({ [STORAGE_KEYS.theme]: theme });
}
