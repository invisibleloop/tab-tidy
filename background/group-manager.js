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

// Move each of this window's rule-owned groups into the given order,
// left to right, starting right after any pinned tabs. Groups not in
// orderedGroupIds (manually-created ones) and ungrouped tabs are left
// wherever Chrome naturally places them relative to this sequence.
async function orderGroupsByRule(windowId, orderedGroupIds) {
  const currentTabs = await chrome.tabs.query({ windowId });

  // Skip entirely if the groups are already in the requested order —
  // chrome.tabGroups.move() visibly reflows the tab strip even when
  // moving a group to the index it's already at.
  const seen = new Set();
  const currentRuleGroupOrder = [];
  for (const tab of currentTabs) {
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && orderedGroupIds.includes(tab.groupId) && !seen.has(tab.groupId)) {
      seen.add(tab.groupId);
      currentRuleGroupOrder.push(tab.groupId);
    }
  }
  const alreadyInOrder = currentRuleGroupOrder.length === orderedGroupIds.length
    && currentRuleGroupOrder.every((id, i) => id === orderedGroupIds[i]);
  if (alreadyInOrder) return;

  const pinnedCount = currentTabs.filter((t) => t.pinned).length;
  let index = pinnedCount;
  for (const groupId of orderedGroupIds) {
    try {
      await chrome.tabGroups.move(groupId, { windowId, index });
      const groupTabs = await chrome.tabs.query({ windowId, groupId });
      index += groupTabs.length;
    } catch {
      // Group no longer exists; skip without advancing the index
    }
  }
}

// applyGroupRules reads autoGroups, mutates it, and writes it back at the
// end. The alarm and manual "Apply Now" can both trigger it independently,
// and with several awaited Chrome API calls per rule a run can take long
// enough for a second call to start before the first has saved — each
// would then read a stale snapshot and the later save clobbers the
// earlier one's changes, including group ids Chrome had already
// recreated. Queue calls so only one run is ever in flight at a time.
let applyQueue = Promise.resolve();

export function applyGroupRules(options) {
  applyQueue = applyQueue.then(() => applyGroupRulesInternal(options), () => applyGroupRulesInternal(options));
  return applyQueue;
}

async function applyGroupRulesInternal({ automatic = false } = {}) {
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
      let existingGroup = null;
      if (existingGroupId !== undefined) {
        try {
          existingGroup = await chrome.tabGroups.get(existingGroupId);
          groupIsValid = true;
        } catch {
          delete windowAutoGroups[rule.id];
        }
      }

      let tabs = windowTabs;
      if (rule.dedupe) {
        // Tabs already sitting in this rule's group are never "incoming
        // duplicates" — only tabs that still need to be moved in can be
        // closed as dupes of something already present. When the tracked
        // group id is stale (groupIsValid is false), tabs still reporting
        // that groupId belong to a group Chrome has already destroyed —
        // treat them the same as "already in group" (leave them alone)
        // rather than comparing them against each other as fresh
        // duplicates, which could close a tab that was never a dupe.
        const alreadyInGroup = windowTabs.filter((t) => t.groupId === existingGroupId);
        const incoming = windowTabs.filter((t) => t.groupId !== existingGroupId);

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
            }
            windowAutoGroups[rule.id] = groupId;
            ruleGroupIds.add(groupId);
          } else {
            groupId = await createGroup(tabIds, windowId);
            windowAutoGroups[rule.id] = groupId;
          }
        }

        // Keep the live tab group's title/colour in sync with the rule —
        // but only call update() when something has actually changed.
        // Chrome visibly reflows the tab strip on every tabGroups.update()
        // call even when the values are identical, which read as a
        // shift-and-settle flicker on every periodic apply.
        const needsUpdate = !groupIsValid
          || existingGroup?.title !== rule.name
          || existingGroup?.color !== rule.color;
        if (needsUpdate) {
          const updateProps = { title: rule.name, color: rule.color };
          if (!groupIsValid) updateProps.collapsed = true;
          await chrome.tabGroups.update(groupId, updateProps);
        }
      } catch (err) {
        console.warn(`Tab Tidy: failed to apply rule "${rule.name}" in window ${windowId}`, err);
        delete windowAutoGroups[rule.id];
      }
    }
  }

  await saveAutoGroups(autoGroups);

  // Reorder every window's rule-owned groups to match the rules list's
  // top-to-bottom order, left to right. Runs on every apply (not just when
  // a group is newly created) so dragging a rule in the popup — or
  // manually reordering a group in Chrome itself — is corrected on the
  // next apply. Groups not owned by any rule are left untouched.
  const ruleOrder = rules.map((r) => r.id);
  for (const [windowIdStr, windowAutoGroups] of Object.entries(autoGroups)) {
    const windowId = Number(windowIdStr);
    const orderedGroupIds = ruleOrder
      .map((ruleId) => windowAutoGroups[ruleId])
      .filter((groupId) => groupId !== undefined);
    if (orderedGroupIds.length > 0) {
      await orderGroupsByRule(windowId, orderedGroupIds);
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
