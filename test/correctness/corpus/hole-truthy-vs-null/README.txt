HOLE 5, null variant (real path lost today): after `x === null` yes, the later `!x` (box `x`) has both answers ruled out ('null' vs 'true'/'false'), so `y` no leads nowhere on any path.
Input reaching the lost route: x = null, y = false -> 'empty' (route x===null yes, y no, x no).
Settle pass must NOT redirect here; zero answers left must fail loudly.
