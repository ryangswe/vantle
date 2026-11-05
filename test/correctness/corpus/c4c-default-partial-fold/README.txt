Case 4 (positional default, partly known condition): errorOnEmpty defaults to true and is substituted, but `!room && true` isn't simplified, so it stays a box unrelated to `room`; its no -> `room` no -> 'null' is dead AND listed as a path.
Needs partial folding (PR 6): `!room && true` -> `!room`; then settle drops 'null'.
Inputs: room = null -> throws 'empty'; room = { t: 'c' } -> 'room'. No input reaches 'null'.
