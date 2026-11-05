Case 5 (typeof narrowing): name(v) is inlined once and shared; its `typeof v === 'string'` box is reached from the caller's `typeof v === 'string'` yes (no is dead) and from `typeof v === 'number'` no (yes is dead); its `typeof v === 'number'` yes -> 'num' is dead (on no listed path, still drawn).
Settle pass should redirect: caller string yes -> v; caller number no -> 'other'; drop both helper boxes and 'num'.
Inputs: v = 'a' -> 'a'; v = 1 -> 'n'; v = true -> 'other'. No input reaches 'num'.
