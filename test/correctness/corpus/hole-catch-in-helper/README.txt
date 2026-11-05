HOLE 6 (real path lost today, nothing listed): `unseen` (extract.ts:446-451) only looks at calls written in the try block and treats repo helpers as seen, so JSON.parse inside load() isn't noticed. The catch is drawn only for load's own throw (s falsy), so its `s` check is answered no and 'bad json' is on no path; notCharted is empty.
Input reaching the lost outcome: s = '{' -> 'bad json'.
Settle pass must start this catch with no facts (and the catch must be listed).
