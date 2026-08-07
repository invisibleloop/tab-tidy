Chrome Extension - Tab Tidy

Overview

A Chrome extension that lets a user define URL match rules and automatically groups open tabs matching those rules into a named, coloured tab group.

The extension never closes or archives tabs — it only groups them.

⸻

Goals

- Let the user create, edit, enable/disable, and delete rules from the popup.
- Each rule has: a name, a match pattern (plain text or regex), a tab group colour, and an enabled flag.
- Matching tabs are grouped per-window into a tab group named after the rule.
- Rules are reapplied automatically (on an alarm, and on browser/service-worker startup) so newly opened tabs matching a rule get grouped without user action.

⸻

Popup UI

The popup contains a single Rules panel:

- List of existing rules (name, colour swatch, match type badge, pattern, enable/disable toggle, edit/delete).
- "+ Add Rule" opens a form to create a new rule (name, match type, pattern, colour).
- "Apply Now" re-runs rule matching immediately.

⸻

Extension Architecture

background/

- event-listeners.js — alarm/startup/install listeners, message handling (SAVE_GROUP_RULES, APPLY_GROUP_RULES)
- group-manager.js — rule matching engine, tab group creation/reconciliation
- service-worker.js — entry point

popup/

- popup.html / popup.js — shell
- rules-panel.js — rules list + add/edit/delete UI

shared/

- constants.js — alarm config, storage keys, tab group colours
- storage.js — storage helpers for groupRules and autoGroups

⸻

Persistence

Persist:

- groupRules: Array<{ id, name, pattern, matchType, color, enabled }>
- autoGroups: { [windowId]: { [ruleId]: groupId } } — tracks which tab group belongs to which rule per window, so rule reapplication reuses existing groups instead of creating duplicates.

⸻

Code Quality

- Use modern JavaScript (ES Modules).
- Keep business logic (group-manager) separate from UI (rules-panel).
- Avoid duplicated logic between background and popup.
