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
            (newGroupsByWindow[windowId] ??= []).push(groupId);
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

  // Pull any newly created groups to the left, right after existing groups.
  // chrome.tabs.group() only removes tabs from the ungrouped sequence and
  // reinserts them next to their group — it never changes the relative
  // order of the other ungrouped tabs, so nothing else needs restoring.
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
