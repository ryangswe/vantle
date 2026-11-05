HOLE (step-box name clash, real path lost today): h's local `mode` is widened, and its step boxes assign `mode = 'b'` / `mode = 'a'`. paths.ts applies assigns by display name, so they constrain the caller's own parameter `mode` in `mode === 'a'`. After step `mode = 'b'`, the caller's yes -> 'A' is ruled out.
Input reaching the lost route: mode = 'a', p = true, a = b = c = d = false, m = 'x' -> 'A' (route p yes, step mode='b', ..., mode===m no, mode==='a' yes).
Settle pass must NOT redirect the caller's `mode === 'a'` from the step boxes.
