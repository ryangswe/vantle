Case 4 (argument the caller already checked), PostHog shape: prep(target, path) is inlined once and shared by two calls; its `target === 'ui'` box is reached from the caller's `target === 'ui'` yes (its no is dead) and from `flags` yes (its yes is dead). prep('assets', path) already folds.
Settle pass should redirect caller yes -> 'ui:' + path and flags yes -> path, dropping the shared box.
Inputs: target = 'ui' -> 'ui:' + path; target = 'api', flags = true -> path.
