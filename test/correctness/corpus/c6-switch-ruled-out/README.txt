Case 6 (switch case ruled out, by type): op is 'a' | 'b' | 'c' and 'c' returned earlier, so h's written `default` -> 'other' is dead, but only if literal-union types are trusted (owner question 1). Without types the settle pass must leave it (no runtime check rules it out).
Inputs: op = 'a' -> 'A', 'b' -> 'B', 'c' -> 'C'. A well-typed input never reaches 'other' (op = 'z' as any does).
