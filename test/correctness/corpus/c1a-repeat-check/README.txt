Dead arrows on a shared box: the second `u.admin` box is reached from `b` = no (u.admin already yes) and from the first `u.admin` = no. Each arrow is live from one incoming arrow and dead from the other; the path list is right (3 paths), the chart is not.
Settle pass should redirect `b` no -> 'admin' and first `u.admin` no -> 'user', dropping the second box.
Inputs: u = { admin: true, plan: 'p' }, b = false -> 'admin' (never 'user'); u.admin = false -> 'user' (never 'admin' via that arrow).
