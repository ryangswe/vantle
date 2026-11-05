# Vantle: notes for coding agents

Vantle is a pre-MVP TypeScript CLI, built in public. Read `README.md` and `ROADMAP.md` first. `SPEC.md` describes what the chart tool does, and `docs/receipts/` describes the receipt, which so far is run by hand.

## Everything here is public

This repository is public, and so is everything you write to it. That includes the code and docs, and also commit messages, branch names, pull request titles and descriptions, and review comments. Before you write any of them, check that none of the following is in it.

- Anything about the maintainer's private projects beyond what the maintainer has already published: no file names, function names, pull request numbers, features, numbers or data from them. Experiment scripts may live here, but data and results from private code stay outside the repo.
- Session ids, chat or session links, local paths such as home folders, account or organization ids, API keys and other secrets.
- Names of people other than the maintainer.
- Comparisons with other products, or claims that Vantle is the first or only tool to do something. Add those only when the maintainer asks.

`scripts/leak-check.sh` checks some of this mechanically, and CI runs it on every push and pull request, along with gitleaks. The check reads files, commit messages and authors, branch names, and pull request text. The maintainer's machine also runs a stricter local check before each push. A clean check doesn't prove that nothing private is in your change, so read your own diff and text with the list above in mind.

## How work is done

- Work on a branch, never on `main`, and open a pull request. The maintainer merges.
- Every change gets a review by a fresh agent that didn't write it, before it's called done.
- Don't add AI attribution to commits or pull requests: no `Co-Authored-By` trailer for an AI and no "Generated with" line.
- Keep the status honest. Vantle is pre-MVP, and the docs say so. Don't describe anything as verified, proven or working beyond what a run has shown.
- Write in full, plain sentences. In running prose, avoid a short lead-in followed by a colon and sentence fragments.

## Commands

```sh
npm ci
npm run typecheck
npm test                              # vitest; up to about two minutes
npx tsx experiments/correctness.ts    # runs each corpus case on many inputs and checks every run against its chart
scripts/leak-check.sh                 # the public leak check
```

The correctness corpus in `test/correctness/corpus/` takes synthetic cases only. Its README says how to write one. Don't copy code from other repositories into tests or fixtures, because this repo is Apache-2.0 and their licences may not allow it.

`label` and `verify` call the Anthropic API and need credentials. Unit tests and the correctness check don't.
