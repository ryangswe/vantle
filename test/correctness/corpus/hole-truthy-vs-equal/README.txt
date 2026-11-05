HOLE 5 (real path lost today): edgeConstraint keys the truthiness test `x` and the equality `x === 'a'` under the same variable `x`, with values 'true'/'false' vs 'a'. After `x === 'a'` yes, both answers of `x` are ruled out, so the arrow `y` no is on no path.
Input reaching the lost route: x = 'a', y = false -> 'set' (route x==='a' yes, y no, x yes).
Settle pass must NOT redirect here; with zero answers left it must keep the arrow and fail loudly.
