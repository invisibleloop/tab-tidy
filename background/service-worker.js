import { registerListeners } from './event-listeners.js';
import { applyGroupRules } from './group-manager.js';

registerListeners();

// Apply rules immediately on service worker startup (covers reload and Chrome restart)
applyGroupRules({ automatic: true });
