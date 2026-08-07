import { getTheme, saveTheme } from './storage.js';

const ICON_SUN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const ICON_MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

const ICONS = { light: ICON_SUN, dark: ICON_MOON };
const LABELS = { light: 'Theme: Light (click for Dark)', dark: 'Theme: Dark (click for Light)' };

// System's actual current preference, used only to pick a starting point
// the first time a theme is ever chosen (before any explicit user choice).
function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export async function initTheme(buttonId) {
  let theme = await getTheme();
  if (theme !== 'light' && theme !== 'dark') {
    theme = systemPrefersDark() ? 'dark' : 'light';
  }
  apply(theme);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.theme && (changes.theme.newValue === 'light' || changes.theme.newValue === 'dark')) {
      apply(changes.theme.newValue);
    }
  });

  const btn = buttonId ? document.getElementById(buttonId) : null;
  if (!btn) return;

  const render = (t) => {
    btn.innerHTML = ICONS[t];
    btn.title = LABELS[t];
    btn.setAttribute('aria-label', LABELS[t]);
  };
  render(theme);

  btn.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    apply(next);
    render(next);
    await saveTheme(next);
  });
}
