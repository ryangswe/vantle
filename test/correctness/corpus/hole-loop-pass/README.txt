HOLE (real path lost today): the loop is drawn as one pass, and identity only counts changes before the check, so the in-loop `x.a` reads as the pre-loop `x.a` (`if (x.a) return 'pre'` is what rules it out); on the second pass it can be true. 'second-pass' is on no path.
Input reaching the lost outcome: x = { a: false }, items = ['go', 'y'] -> 'second-pass' (needs two passes; the correctness check reports multi-pass runs as unjudged).
Settle pass must NOT resolve the in-loop `x.a` check.
