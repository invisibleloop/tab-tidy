import { getGroupRules, getAutoGroups, saveAutoGroups } from '../shared/storage.js';

function buildMatcher(rule) {
  if (rule.matchType === 'string') {
    const lower = rule.pattern.toLowerCase();
    return (url) => url.toLowerCase().includes(lower);
  }
  try {
    const regex = new RegExp(rule.pattern, 'i');
    return (url) => regex.test(url);
  } catch {
    return () => false;
  }
}

// Snapshot the ordering of ungrouped tabs only. Existing groups (rule-owned
// or manual) are never repositioned by this module, so their order doesn't
// need tracking — only ungrouped tabs can get shuffled as a side effect of
// chrome.tabs.group() relocating a tab next to its new group.
async function snapshotUngroupedOrder(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs
    .filter((tab) => !tab.pinned)
    .filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://'))
    .filter((tab) => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    .map((tab) => tab.id);
}

// Move a freshly created group to sit immediately after the last existing
// group in the window (or right after any pinned tabs if there are no
// other groups yet), so new groups collect at the left rather than
// wherever their matching tabs happened to be.
async function positionGroupAfterExisting(windowId, groupId) {
  const currentTabs = await chrome.tabs.query({ windowId });
  const pinnedCount = currentTabs.filter((t) => t.pinned).length;

  // Count through the leading run of grouped tabs (skipping our own group,
  // which may already be among them) and stop at the first ungrouped tab —
  // that boundary is "as far left as possible, right of existing groups".
  let index = pinnedCount;
  for (const tab of currentTabs) {
    if (tab.pinned) continue;
    if (tab.groupId === groupId) continue;
    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) break;
    index += 1;
  }

  try {
    await chrome.tabGroups.move(groupId, { windowId, index });
  } catch {
    // Group may have been closed already; nothing to do
  }
}

// Restore the relative order of previously-ungrouped tabs that are still
// ungrouped (tabs that just got grouped are excluded by the caller). This
// never moves a group — groups keep whatever position Chrome naturally
// gives them, so manually-created groups are never touched.
async function restoreUngroupedOrder(tabIds) {
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.move(tabId, { index: -1 });
    } catch {
      // Tab no longer exists; skip
    }
  }
}

export async function applyGroupRules({ automatic = false } = {}) {
  const rules = await getGroupRules();
  const enabledRules = rules.filter((r) => r.enabled && (!automatic || r.autoApply !== false));
  if (enabledRules.length === 0) return;

  const allTabs = await chrome.tabs.query({});
  const autoGroups = await getAutoGroups();

  // Group IDs that rules created/own. Tabs sitting in some other,
  // manually-created group are left alone even if their URL matches.
  const ruleGroupIds = new Set(
    Object.values(autoGroups).flatMap((windowGroups) => Object.values(windowGroups))
  );

  // Snapshot the ungrouped-tab order per window before making any changes
  const windowIds = [...new Set(allTabs.map((t) => t.windowId))];
  const ungroupedOrderBefore = {};
  for (const windowId of windowIds) {
    ungroupedOrderBefore[windowId] = await snapshotUngroupedOrder(windowId);
  }

  // Tabs that get newly grouped this run should stay wherever chrome.tabs.group()
  // puts them, not snap back to their pre-group ungrouped slot.
  const movedTabIds = new Set();

  // Groups created this run, so we can position them at the left after
  // the tab order has been restored (positioning them earlier would just
  // get undone by the restore pass below).
  const newGroupsByWindow = {};

  for (const rule of enabledRules) {
    const matches = buildMatcher(rule);
    const matchingTabs = allTabs.filter((tab) => {
      if (!tab.url || tab.pinned || !matches(tab.url)) return false;
      const inOtherGroup = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !ruleGroupIds.has(tab.groupId);
      return !inOtherGroup;
    });
    if (matchingTabs.length === 0) continue;

    // Group by window
    const byWindow = {};
    for (const tab of matchingTabs) {
      (byWindow[tab.windowId] ??= []).push(tab);
    }

    for (const [windowIdStr, windowTabs] of Object.entries(byWindow)) {
      const windowId = Number(windowIdStr);

      const windowAutoGroups = autoGroups[windowIdStr] ??= {};
      const existingGroupId = windowAutoGroups[rule.id];

      let groupId;
      let groupIsValid = false;
      if (existingGroupId !== undefined) {
        try {
          await chrome.tabGroups.get(existingGroupId);
          groupIsValid = true;
        } catch {
          delete windowAutoGroups[rule.id];
        }
      }

      let tabs = windowTabs;
      if (rule.dedupe) {
        // Tabs already sitting in this rule's group are never "incoming
        // duplicates" — only tabs that still need to be moved in can be
        // closed as dupes of something already present.
        const alreadyInGroup = groupIsValid
          ? windowTabs.filter((t) => t.groupId === existingGroupId)
          : [];
        const incoming = groupIsValid
          ? windowTabs.filter((t) => t.groupId !== existingGroupId)
          : windowTabs;

        const seenUrls = new Set(alreadyInGroup.map((t) => t.url));
        const toClose = [];
        const dedupedIncoming = incoming.filter((t) => {
          if (seenUrls.has(t.url)) {
            toClose.push(t.id);
            return false;
          }
          seenUrls.add(t.url);
          return true;
        });
        if (toClose.length > 0) {
          await chrome.tabs.remove(toClose);
        }
        tabs = [...alreadyInGroup, ...dedupedIncoming];
      }

      if (tabs.length === 0) continue;
      const tabIds = tabs.map((t) => t.id);

      // A tab can vanish between being queried above and being grouped
      // here (closed by the user, or by dedupe just above). Any Chrome
      // API call in this block can then throw — catch it per-window/rule
      // so one stale tab doesn't abort processing for every other rule.
      try {
        if (groupIsValid) {
          // Only move tabs that aren't already in this group
          const tabsToMove = tabs.filter((t) => t.groupId !== existingGroupId);
          if (tabsToMove.length > 0) {
            await chrome.tabs.group({ tabIds: tabsToMove.map((t) => t.id), groupId: existingGroupId });
            for (const t of tabsToMove) movedTabIds.add(t.id);
          }
          groupId = existingGroupId;
        } else {
          // No group tracked for this rule yet. Before creating a new one,
          // check for an unmanaged tab group in this window with the exact
          // same name — likely left behind by a deleted/recreated rule of
          // the same name — and adopt it instead of making a duplicate.
          const adoptable = await findAdoptableGroup(windowId, rule.name, ruleGroupIds);
          if (adoptable !== null) {
            groupId = adoptable;
            const tabsToMove = tabs.filter((t) => t.groupId !== groupId);
            if (tabsToMove.length > 0) {
              await chrome.tabs.group({ tabIds: tabsToMove.map((t) => t.id), groupId });
              for (const t of tabsToMove) movedTabIds.add(t.id);
            }
            windowAutoGroups[rule.id] = groupId;
            ruleGroupIds.add(groupId);
          } else {
            groupId = await createGroup(tabIds, windowId);
            windowAutoGroups[rule.id] = groupId;
            for (const t of tabs) movedTabIds.add(t.id);
            (newGroupsByWindow[windowId] ??= []).push(groupId);
          }
        }

        // Keep the live tab group's title/colour in sync with the rule,
        // even when the group already existed and no tabs needed to move —
        // otherwise renaming/recolouring a rule would never reach the browser.
        const updateProps = { title: rule.name, color: rule.color };
        if (!groupIsValid) updateProps.collapsed = true;
        await chrome.tabGroups.update(groupId, updateProps);
      } catch (err) {
        console.warn(`Tab Tidy: failed to apply rule "${rule.name}" in window ${windowId}`, err);
        delete windowAutoGroups[rule.id];
      }
    }
  }

  await saveAutoGroups(autoGroups);

  // Restore the relative order of tabs that are still ungrouped, in windows
  // where a tab was actually moved this run. Groups — rule-owned or
  // manually created — are never repositioned here.
  const touchedWindowIds = new Set(
    [...movedTabIds].map((tabId) => allTabs.find((t) => t.id === tabId)?.windowId)
  );
  for (const windowId of windowIds) {
    if (!touchedWindowIds.has(windowId)) continue;
    const stillUngrouped = ungroupedOrderBefore[windowId].filter((tabId) => !movedTabIds.has(tabId));
    await restoreUngroupedOrder(stillUngrouped);
  }

  // Now that ungrouped tabs are back in their original relative order, pull
  // any newly created groups to the left, right after existing groups.
  for (const [windowIdStr, groupIds] of Object.entries(newGroupsByWindow)) {
    const windowId = Number(windowIdStr);
    for (const groupId of groupIds) {
      await positionGroupAfterExisting(windowId, groupId);
    }
  }
}

// Look for a tab group in this window with the exact same title as the
// rule, that isn't already owned by another rule. Case-sensitive exact
// match, since that's what the rule itself sets as the group title.
async function findAdoptableGroup(windowId, ruleName, ruleGroupIds) {
  const groups = await chrome.tabGroups.query({ windowId });
  const match = groups.find((g) => g.title === ruleName && !ruleGroupIds.has(g.id));
  return match ? match.id : null;
}

// Title/colour are applied by the caller's guarded sync pass right after
// this returns — not duplicated here, since chrome.tabs.group() can hand
// back a group whose tabs were closed a moment later (e.g. by dedupe),
// leaving the group itself gone before an unguarded update would run.
async function createGroup(tabIds, windowId) {
  return chrome.tabs.group({ tabIds, createProperties: { windowId } });
}

// Clean up stored group IDs for rules that no longer exist
export async function reconcileAutoGroups() {
  const rules = await getGroupRules();
  const ruleIds = new Set(rules.map((r) => r.id));
  const autoGroups = await getAutoGroups();
  let changed = false;

  for (const windowGroups of Object.values(autoGroups)) {
    for (const ruleId of Object.keys(windowGroups)) {
      if (!ruleIds.has(ruleId)) {
        delete windowGroups[ruleId];
        changed = true;
      }
    }
  }

  if (changed) await saveAutoGroups(autoGroups);
}
