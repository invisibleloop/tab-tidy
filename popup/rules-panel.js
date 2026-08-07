import { getGroupRules, saveGroupRules, getApplyIntervalMinutes, saveViewingRule, getCompactRulesView, saveCompactRulesView } from '../shared/storage.js';
import { TAB_GROUP_COLORS, APPLY_INTERVAL_OPTIONS } from '../shared/constants.js';

async function applyGroupRules() {
  await chrome.runtime.sendMessage({ type: 'APPLY_GROUP_RULES' });
}

async function viewRuleTabs(ruleId) {
  const currentWindow = await chrome.windows.getCurrent();
  await saveViewingRule(ruleId, currentWindow.id);
  await chrome.sidePanel.open({ windowId: currentWindow.id });
  window.close();
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

// Lucide icons (stroke-based, 24x24 viewBox), inlined so no external
// requests are needed. currentColor lets each button's CSS color apply.
const ICON_EYE = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_PENCIL = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
const ICON_TRASH = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_ROWS = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>';

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colorSwatch(color) {
  const MAP = {
    grey: '#9e9e9e', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
    green: '#1e8e3e', pink: '#e52592', purple: '#9334e6', cyan: '#007b83', orange: '#e8710a',
  };
  return MAP[color] || '#9e9e9e';
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    document.getElementById('confirm-dialog-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'confirm-dialog-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <p class="confirm-dialog-message">${escHtml(message)}</p>
        <div class="confirm-dialog-actions">
          <button id="confirm-dialog-cancel">Cancel</button>
          <button id="confirm-dialog-confirm" class="danger">Delete</button>
        </div>
      </div>
    `;

    document.querySelector('main').appendChild(overlay);

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('#confirm-dialog-cancel').addEventListener('click', () => finish(false));
    overlay.querySelector('#confirm-dialog-confirm').addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
  });
}

async function initIntervalControl() {
  const select = document.getElementById('apply-interval');
  select.innerHTML = APPLY_INTERVAL_OPTIONS.map(
    (opt) => `<option value="${opt.minutes}">${opt.label}</option>`
  ).join('');

  select.value = await getApplyIntervalMinutes();

  select.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'SAVE_APPLY_INTERVAL', minutes: Number(select.value) });
  });
}

async function initCompactViewToggle(container) {
  const btn = document.getElementById('btn-compact-view');
  btn.innerHTML = ICON_ROWS;

  const compact = await getCompactRulesView();
  container.classList.toggle('compact', compact);
  btn.classList.toggle('active', compact);

  btn.addEventListener('click', async () => {
    const isCompact = container.classList.toggle('compact');
    btn.classList.toggle('active', isCompact);
    await saveCompactRulesView(isCompact);
  });
}

export async function initRules() {
  const container = document.getElementById('rules-list');
  const emptyMsg = document.getElementById('rules-empty');
  const addBtn = document.getElementById('btn-add-rule');
  const applyBtn = document.getElementById('btn-apply-rules');

  await initIntervalControl();
  await initCompactViewToggle(container);

  async function render() {
    const rules = await getGroupRules();
    container.innerHTML = '';

    if (rules.length === 0) {
      emptyMsg.classList.remove('hidden');
    } else {
      emptyMsg.classList.add('hidden');
    }

    for (const rule of rules) {
      const item = document.createElement('div');
      item.className = 'rule-item';
      item.classList.toggle('rule-item--disabled', !rule.enabled);
      item.dataset.id = rule.id;
      item.draggable = true;

      const matchLabel = rule.matchType === 'string' ? 'string' : 'regex';
      const autoApply = rule.autoApply ?? true;

      item.innerHTML = `
        <div class="rule-header">
          <span class="rule-drag-handle" title="Drag to reorder">⠿</span>
          <span class="rule-swatch" style="background:${colorSwatch(rule.color)}"></span>
          <span class="rule-name">${escHtml(rule.name)}</span>
          <span class="rule-match-badge rule-match-badge--${matchLabel}">${matchLabel}</span>
          <span class="rule-apply-badge" title="${autoApply ? 'Applies automatically' : 'Manual apply only'}">${autoApply ? 'auto' : 'manual'}</span>
          ${rule.dedupe ? '<span class="rule-apply-badge" title="Closes duplicate tabs">dedupe</span>' : ''}
        </div>
        <div class="rule-pattern">${escHtml(rule.pattern)}</div>
        <div class="rule-actions">
          <button class="rule-icon-btn rule-view-btn" title="View tabs in this group" aria-label="View tabs">${ICON_EYE}</button>
          <button class="rule-icon-btn rule-edit-btn" title="Edit rule" aria-label="Edit rule">${ICON_PENCIL}</button>
          <button class="rule-icon-btn rule-delete-btn danger" title="Delete rule" aria-label="Delete rule">${ICON_TRASH}</button>
          <label class="rule-toggle" title="Enable/disable">
            <span class="rule-toggle-label">${rule.enabled ? 'Enabled' : 'Disabled'}</span>
            <input type="checkbox" class="rule-enabled" ${rule.enabled ? 'checked' : ''} />
            <span class="rule-toggle-track"></span>
          </label>
        </div>
      `;

      item.querySelector('.rule-enabled').addEventListener('change', async (e) => {
        item.querySelector('.rule-toggle-label').textContent = e.target.checked ? 'Enabled' : 'Disabled';
        item.classList.toggle('rule-item--disabled', !e.target.checked);
        const rules = await getGroupRules();
        const r = rules.find((r) => r.id === rule.id);
        if (r) r.enabled = e.target.checked;
        await saveGroupRules(rules);
        if (e.target.checked) await applyGroupRules();
      });

      item.querySelector('.rule-view-btn').addEventListener('click', () => viewRuleTabs(rule.id));
      item.querySelector('.rule-edit-btn').addEventListener('click', () => openForm(rule, render));
      item.querySelector('.rule-delete-btn').addEventListener('click', async () => {
        const confirmed = await confirmDialog(`Delete rule "${rule.name}"?`);
        if (!confirmed) return;
        const rules = await getGroupRules();
        await saveGroupRules(rules.filter((r) => r.id !== rule.id));
        render();
      });

      item.addEventListener('dragstart', () => {
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
      });

      container.appendChild(item);
    }
  }

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = container.querySelector('.rule-item.dragging');
    if (!dragging) return;

    const siblings = [...container.querySelectorAll('.rule-item:not(.dragging)')];
    const after = siblings.find((sibling) => {
      const rect = sibling.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });

    if (after) {
      container.insertBefore(dragging, after);
    } else {
      container.appendChild(dragging);
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const orderedIds = [...container.querySelectorAll('.rule-item')].map((el) => el.dataset.id);
    const rules = await getGroupRules();
    const reordered = orderedIds
      .map((id) => rules.find((r) => r.id === id))
      .filter(Boolean);
    await saveGroupRules(reordered);
    await applyGroupRules();
  });

  addBtn.addEventListener('click', () => openForm(null, render));
  applyBtn.addEventListener('click', () => applyGroupRules());

  await render();
}

function openForm(existing, onSave) {
  document.getElementById('rule-form-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'rule-form-overlay';

  const colorOptions = TAB_GROUP_COLORS.map((c) => `
    <label class="color-option" title="${c}">
      <input type="radio" name="rule-color" value="${c}" ${(existing?.color ?? 'blue') === c ? 'checked' : ''} />
      <span class="color-dot" style="background:${colorSwatch(c)}"></span>
    </label>
  `).join('');

  const currentMatchType = existing?.matchType ?? 'regex';

  overlay.innerHTML = `
    <div class="rule-form">
      <h3>${existing ? 'Edit rule' : 'New rule'}</h3>
      <label>
        Group name
        <input type="text" id="rf-name" value="${escHtml(existing?.name ?? '')}" placeholder="e.g. GitHub" maxlength="50" />
      </label>
      <p id="rf-name-error" class="form-error hidden">Group name is required</p>
      <div class="match-type-row">
        <label class="match-type-option">
          <input type="radio" name="rf-match-type" value="string" ${currentMatchType === 'string' ? 'checked' : ''} />
          Plain text
        </label>
        <label class="match-type-option">
          <input type="radio" name="rf-match-type" value="regex" ${currentMatchType === 'regex' ? 'checked' : ''} />
          Regex
        </label>
      </div>
      <label>
        <span id="rf-pattern-label">URL contains</span>
        <input type="text" id="rf-pattern" value="${escHtml(existing?.pattern ?? '')}" placeholder="e.g. github.com" />
      </label>
      <p id="rf-pattern-error" class="form-error hidden">Invalid regex</p>
      <div class="color-picker-row">
        <span class="color-picker-label">Colour</span>
        <div class="color-options">${colorOptions}</div>
      </div>
      <label class="rule-toggle rule-toggle--form" title="Apply automatically">
        <span class="rule-toggle-label">Apply automatically</span>
        <input type="checkbox" id="rf-auto-apply" ${(existing?.autoApply ?? true) ? 'checked' : ''} />
        <span class="rule-toggle-track"></span>
      </label>
      <label class="rule-toggle rule-toggle--form" title="Close duplicate tabs">
        <span class="rule-toggle-label">Dedupe (close duplicate tabs)</span>
        <input type="checkbox" id="rf-dedupe" ${existing?.dedupe ? 'checked' : ''} />
        <span class="rule-toggle-track"></span>
      </label>
      <div class="rule-form-actions">
        <button id="rf-cancel">Cancel</button>
        <button id="rf-save" class="save-btn">Save</button>
      </div>
    </div>
  `;

  document.querySelector('main').appendChild(overlay);

  const patternLabel = overlay.querySelector('#rf-pattern-label');
  const patternInput = overlay.querySelector('#rf-pattern');
  const errorEl = overlay.querySelector('#rf-pattern-error');
  const nameErrorEl = overlay.querySelector('#rf-name-error');

  function updateLabel() {
    const type = overlay.querySelector('input[name="rf-match-type"]:checked')?.value;
    if (type === 'regex') {
      patternLabel.textContent = 'URL pattern (regex)';
      patternInput.placeholder = 'e.g. github\\.com';
    } else {
      patternLabel.textContent = 'URL contains';
      patternInput.placeholder = 'e.g. github.com';
    }
    errorEl.classList.add('hidden');
  }

  overlay.querySelectorAll('input[name="rf-match-type"]').forEach((r) =>
    r.addEventListener('change', updateLabel)
  );
  updateLabel();
  patternInput.addEventListener('input', () => errorEl.classList.add('hidden'));

  overlay.querySelector('#rf-cancel').addEventListener('click', () => overlay.remove());

  const nameInput = overlay.querySelector('#rf-name');
  nameInput.addEventListener('input', () => nameErrorEl.classList.add('hidden'));

  overlay.querySelector('#rf-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const pattern = patternInput.value.trim();
    const color = overlay.querySelector('input[name="rule-color"]:checked')?.value ?? 'blue';
    const matchType = overlay.querySelector('input[name="rf-match-type"]:checked')?.value ?? 'string';
    const autoApply = overlay.querySelector('#rf-auto-apply').checked;
    const dedupe = overlay.querySelector('#rf-dedupe').checked;

    nameErrorEl.classList.toggle('hidden', !!name);

    let patternValid = true;
    if (!pattern) {
      errorEl.textContent = 'URL pattern is required';
      errorEl.classList.remove('hidden');
      patternValid = false;
    } else if (matchType === 'regex') {
      try {
        new RegExp(pattern);
        errorEl.classList.add('hidden');
      } catch {
        errorEl.textContent = 'Invalid regex';
        errorEl.classList.remove('hidden');
        patternValid = false;
      }
    } else {
      errorEl.classList.add('hidden');
    }

    if (!name || !patternValid) {
      (!name ? nameInput : patternInput).focus();
      return;
    }

    const rules = await getGroupRules();

    if (existing) {
      const r = rules.find((r) => r.id === existing.id);
      if (r) { r.name = name; r.pattern = pattern; r.color = color; r.matchType = matchType; r.autoApply = autoApply; r.dedupe = dedupe; }
    } else {
      rules.push({ id: makeId(), name, pattern, color, matchType, enabled: true, autoApply, dedupe });
    }

    await saveGroupRules(rules);
    await applyGroupRules();
    overlay.remove();
    onSave();
  });
}
