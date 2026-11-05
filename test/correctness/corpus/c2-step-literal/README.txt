Case 2 (literal a step box set), widened join: step boxes `mode = 'b'` / `mode = 'a'` lead to the shared run a, b, c, d, then `mode === 'a'`. Each arrow of `mode === 'a'` is dead from one step box. Path list is right (10 paths).
Expected: the settle pass alone does NOT fix this (the check isn't the step's direct successor); only optional copying past the join (PR 7) would. Use as a "no change, no wrong redirect" case.
Inputs: p = true, a = b = c = d = false -> 'modeB' (never 'modeA'); p = false -> 'modeA'.
