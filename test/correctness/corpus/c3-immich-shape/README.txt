Case 3 (caller's check before an inlined helper), Immich shape: the helper's `request.ids.size === 0` is shown as `({...}).ids.size === 0` with key #request=..., the caller's as `idSet.size === 0`; different keys, so the dead yes arrow -> 'empty' is drawn AND listed on a path (an infeasible path today).
Needs value terms (request.ids is idSet). Then the settle pass should drop the helper's size check and 'empty'.
Inputs: no input reaches 'empty'; ids = ['1'], permission = 'r' -> 'read'.
