export const ALARM_NAME = 'apply-group-rules';
export const DEFAULT_APPLY_INTERVAL_MINUTES = 1;

export const APPLY_INTERVAL_OPTIONS = [
  { label: '1 minute', minutes: 1 },
  { label: '5 minutes', minutes: 5 },
  { label: '15 minutes', minutes: 15 },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
];

export const STORAGE_KEYS = {
  groupRules: 'groupRules',
  autoGroups: 'autoGroups',
  applyIntervalMinutes: 'applyIntervalMinutes',
  viewingRule: 'viewingRule',
  compactRulesView: 'compactRulesView',
  theme: 'theme',
  sidePanelSort: 'sidePanelSort',
};

export const TAB_GROUP_COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
];
