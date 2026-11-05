Case 4 (destructured defaults, Rocket.Chat shape): getRoom({}, room) leaves type = undefined and errorOnEmpty = true, but destructured parameters aren't bound, so `type && ...` is drawn with a dead yes -> 'wrongType', and `!room && errorOnEmpty` no -> `room` no -> 'null' is dead.
Needs binding in the walk (PR 6): `type && ...` folds to false, `!room && errorOnEmpty` becomes `!room`, then settle drops `room` no -> 'null'.
Inputs: room = null -> throws 'empty'; room = { t: 'c' } -> 'room'. No input reaches 'wrongType' or 'null'.
