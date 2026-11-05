HOLE (real path lost today): demote(holder.user) changes the object `u` when holder.user === u, but only `holder` is marked changed, so the second `u.admin` is treated as the first and 'revoked' is on no path.
Input reaching the lost outcome: const u = { admin: true }; holder = { user: u } (same object), b = true -> 'revoked'.
Settle pass must NOT resolve the second `u.admin` check.
