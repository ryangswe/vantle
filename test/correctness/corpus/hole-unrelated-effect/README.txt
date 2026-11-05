HOLE (real path lost today): lockEverything() takes no arguments, so nothing is marked changed, and the second repo.isLocked(id) is treated as the same question as the first; 'now locked' is on no path.
Input reaching the lost outcome: repo.isLocked returns false until lockEverything() has run, then true (shared state in the stubs); id = 'x', force = true -> 'now locked'.
Note: needs a stub where an unrelated call changes what a lookup returns. Settle pass must NOT resolve the second check (if the owner picks the strict rule).
