# Correctness-check corpus

Each folder is one case for `experiments/correctness.ts`: a small project in `src/` with one function marked `@vantle`, the inputs to run it on (`inputs.json`), and optionally `case.json` (`{ "name", "options" }`). The input format is described at the top of `experiments/correctness.ts`.

Every bug a reviewer finds in a chart should get a case here, with inputs that show it.

- `r*`, `b*`, `h1`, `w1`, `p*`: the PR #16 code reviewer's repros and probes.
- `c*`, `endpointfor-shape`: dead-arrow shapes from the core design review. Each `README.txt` says what the chart should become.
- `hole-*`: places where the extractor drops a path the code can take. These fail today and are the first fixes to make.

Every case is synthetic or only borrows the shape of a public function. Don't copy code from other repos into a case: write a small function with the same shape instead, so the corpus can be published under this repo's licence. `p1`, `p2` and `p5` were rewritten this way.
