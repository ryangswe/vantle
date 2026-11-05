Case 3 when both checks read the same text: the helper's `idSet.size === 0` has the same key as the caller's, so the path list already excludes 'empty', but the chart still draws the dead yes arrow -> 'empty'.
Settle pass (v1, today's keys) should redirect it away and drop 'empty'.
Inputs: no input reaches 'empty'; idSet = new Set(['1']), permission = 'x' -> 'deny'.
