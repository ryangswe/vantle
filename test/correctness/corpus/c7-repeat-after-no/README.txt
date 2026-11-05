Case 1, globally dead: the inner `user.role === 'admin'` is only reached after the outer one answered no, so its yes -> 'dead' is on no listed path but still drawn.
Settle pass should redirect `x` yes -> the 'guest' check and drop the inner box and 'dead'.
Inputs: no input reaches 'dead'; user = { banned: false, role: 'member' }, x = true -> 'member'.
