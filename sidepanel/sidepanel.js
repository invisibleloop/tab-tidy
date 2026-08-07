import { getGroupRules, getAutoGroups, getViewingRule } from '../shared/storage.js';
import { initTheme } from '../shared/theme.js';

initTheme();

function colorSwatch(color) {
  const MAP = {
    grey: '#9e9e9e', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
    green: '#1e8e3e', pink: '#e52592', purple: '#9334e6', cyan: '#007b83', orange: '#e8710a',
  };
  return MAP[color] || '#9e9e9e';
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const headerSwatch = document.getElementById('header-swatch');
const headerTitle = document.getElementById('header-title');
const headerCount = document.getElementById('header-count');
const cardList = document.getElementById('card-list');
const emptyMsg = document.getElementById('empty-msg');
const noSelectionMsg = document.getElementById('no-selection-msg');

let currentGroupId = null;

async function resolveGroup() {
  const viewing = await getViewingRule();
  if (!viewing) return { status: 'no-selection' };

  const [rules, autoGroups] = await Promise.all([getGroupRules(), getAutoGroups()]);
  const rule = rules.find((r) => r.id === viewing.ruleId);
  if (!rule) return { status: 'no-selection' };

  const windowGroups = autoGroups[viewing.windowId];
  const groupId = windowGroups?.[viewing.ruleId];
  if (groupId === undefined) return { status: 'no-group', rule };

  return { status: 'ok', rule, groupId };
}

function buildCard(tab) {
  const card = document.createElement('div');
  card.className = 'tab-card';
  card.dataset.tabId = tab.id;

  card.innerHTML = `
    <img class="tab-favicon" alt="" />
    <div class="tab-card-info">
      <div class="tab-card-title"></div>
      <div class="tab-card-url"></div>
    </div>
    <button class="tab-card-close" title="Close tab">✕</button>
  `;

  card.querySelector('.tab-card-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.tabs.remove(Number(card.dataset.tabId));
  });

  card.addEventListener('click', async () => {
    const tabId = Number(card.dataset.tabId);
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  });

  updateCard(card, tab);
  return card;
}

function updateCard(card, tab) {
  const favicon = card.querySelector('.tab-favicon');
  if (tab.favIconUrl) {
    favicon.src = tab.favIconUrl;
    favicon.classList.remove('tab-favicon--placeholder');
  } else {
    favicon.removeAttribute('src');
    favicon.classList.add('tab-favicon--placeholder');
  }

  const title = tab.title || tab.url;
  const domain = getDomain(tab.url);
  const titleEl = card.querySelector('.tab-card-title');
  const urlEl = card.querySelector('.tab-card-url');
  if (titleEl.textContent !== title) titleEl.textContent = title;
  if (urlEl.textContent !== domain) urlEl.textContent = domain;
}

// Reconcile the card list against the current tab set by id, updating
// existing cards in place rather than tearing down the DOM — a full
// rebuild on every tab event was resetting hover/transition state and
// reading as a flash whenever you hovered a card.
function renderCards(tabs) {
  if (tabs.length === 0) {
    cardList.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  const existingCards = new Map(
    [...cardList.children].map((el) => [el.dataset.tabId, el])
  );

  let previousEl = null;
  for (const tab of tabs) {
    const key = String(tab.id);
    let card = existingCards.get(key);
    if (card) {
      updateCard(card, tab);
      existingCards.delete(key);
    } else {
      card = buildCard(tab);
    }

    // Ensure DOM order matches tab order
    if (previousEl) {
      if (previousEl.nextSibling !== card) cardList.insertBefore(card, previousEl.nextSibling);
    } else if (cardList.firstChild !== card) {
      cardList.insertBefore(card, cardList.firstChild);
    }
    previousEl = card;
  }

  // Remove cards for tabs that are no longer in this group
  for (const staleCard of existingCards.values()) {
    staleCard.remove();
  }
}

async function render() {
  const resolved = await resolveGroup();

  if (resolved.status === 'no-selection') {
    currentGroupId = null;
    headerTitle.textContent = 'Rule tabs';
    headerSwatch.style.background = 'transparent';
    headerCount.textContent = '';
    cardList.innerHTML = '';
    emptyMsg.classList.add('hidden');
    noSelectionMsg.textContent = 'Open this panel from a rule in the extension popup.';
    noSelectionMsg.classList.remove('hidden');
    return;
  }

  if (resolved.status === 'no-group') {
    currentGroupId = null;
    headerTitle.textContent = resolved.rule.name;
    headerSwatch.style.background = colorSwatch(resolved.rule.color);
    headerCount.textContent = '';
    cardList.innerHTML = '';
    emptyMsg.classList.add('hidden');
    noSelectionMsg.textContent = 'This rule has no open tabs yet.';
    noSelectionMsg.classList.remove('hidden');
    return;
  }

  noSelectionMsg.classList.add('hidden');
  const { rule, groupId } = resolved;
  currentGroupId = groupId;

  headerTitle.textContent = rule.name;
  headerSwatch.style.background = colorSwatch(rule.color);

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ groupId });
  } catch {
    tabs = [];
  }

  headerCount.textContent = tabs.length > 0 ? String(tabs.length) : '';
  renderCards(tabs);
}

chrome.tabs.onCreated.addListener(() => render());
chrome.tabs.onRemoved.addListener(() => render());
chrome.tabs.onMoved.addListener(() => render());
chrome.tabs.onAttached.addListener(() => render());
chrome.tabs.onDetached.addListener(() => render());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only re-render for changes to a tab in the group we're currently
  // showing — avoids churn (and the resulting hover flash) from unrelated
  // background tabs updating their favicon/title/status elsewhere.
  if (tab.groupId !== currentGroupId) return;
  if (changeInfo.title !== undefined || changeInfo.favIconUrl !== undefined || changeInfo.url !== undefined || changeInfo.status === 'complete') {
    render();
  }
});
chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.id === currentGroupId) render();
});
chrome.tabGroups.onUpdated.addListener((group) => {
  if (group.id === currentGroupId) render();
});
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.viewingRule) render();
});

render();
