Dead arrow: isAdmin(u) is inlined twice; the second copy's `u.admin` is only reached after the first answered yes, so its no arrow -> 'never' is dead (on no listed path, still drawn).
Settle pass should redirect `b` no straight to 'admin' and drop the second box and 'never'.
Inputs: no input reaches 'never'; u = { admin: true, plan: 'p' }, b = false -> 'admin'.
