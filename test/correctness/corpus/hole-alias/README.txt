HOLE (real path lost today): `a` aliases `u`, so `a.admin = false` changes what the second `u.admin` reads, but both checks get the same identity and the path to 'revoked' is ruled out (2 paths; 'revoked' on none).
Input reaching the lost outcome: u = { admin: true }, b = true -> 'revoked'.
Settle pass must NOT resolve the second `u.admin` check.
