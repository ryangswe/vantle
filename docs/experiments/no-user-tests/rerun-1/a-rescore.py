# Usable count after the first extractor fixes: the latest verdict for each of the 60 charts.
# Run from this folder: python3 a-rescore.py
# Round r (2-5) re-reviewed the charts in a{r}-todo.json: those that passed the mechanical
# checks and had changed since the round before. Every other chart keeps its verdict from the
# round it last changed in; the first verdicts are in ../a-review. summaries/ holds the final
# extraction (after the last fix, which changed no chart that passes the mechanical checks). No chart changed while too big to review and then shrank back
# unreviewed; that was checked when the rounds ran.
import json, glob, collections
ROUNDS = [2, 3, 4, 5]
def load(d):
    out = {}
    for f in glob.glob(f'{d}/*.json'):
        for r in json.load(open(f)): out[(r['repo'], int(r['rank']))] = r
    return out
first = load('../a-review')
reviews = {r: load(f'a{r}-review') for r in ROUNDS}
todos = {r: {(x.rsplit('#', 1)[0], int(x.rsplit('#', 1)[1])) for x in json.load(open(f'a{r}-todo.json'))} for r in ROUNDS}
rows = []
for (repo, rank), old in sorted(first.items()):
    try:
        chart = next(c for c in json.load(open(f'summaries/{repo}.json'))['charts'] if c['rank'] == rank)
    except (FileNotFoundError, StopIteration):
        chart = None
    if chart is None:
        rows.append({**old, 'before': old['usable'], 'after': old['usable'], 'src': 'a', 'boxes': None}); continue
    if not chart.get('mechanical'):
        boxes = chart.get('boxes') or 0
        cat = 'too-big' if boxes > 50 else ('long-labels' if boxes >= 2 else old['category'])
        rows.append({'repo': repo, 'rank': rank, 'before': old['usable'], 'after': False, 'category': cat, 'faithful': None, 'src': 'mechanical', 'boxes': boxes}); continue
    src = next((r for r in reversed(ROUNDS) if (repo, rank) in todos[r]), None)
    v = reviews[src][(repo, rank)] if src else old
    rows.append({'repo': repo, 'rank': rank, 'before': old['usable'], 'after': v['usable'], 'category': v['category'], 'faithful': v.get('faithful'), 'src': f'a{src}' if src else 'a', 'boxes': chart.get('boxes')})
# Twenty's scan didn't finish, so its three charts were never extracted or reviewed.
rows += [{'repo': 'twentyhq_twenty', 'rank': k, 'before': False, 'after': False, 'category': 'scan-timeout', 'faithful': None, 'src': 'a', 'boxes': None} for k in (1, 2, 3)]
print('charts', len(rows), '| usable before', sum(r['before'] for r in rows), '| after', sum(r['after'] for r in rows))
print('became usable:', [(r['repo'], r['rank']) for r in rows if r['after'] and not r['before']])
print('stopped being usable:', [(r['repo'], r['rank'], r['category'], r['boxes']) for r in rows if r['before'] and not r['after']])
print('main reasons now:', collections.Counter(r['category'] for r in rows if not r['after']).most_common())
mech = [r for r in rows if r['src'] != 'mechanical' and r['boxes'] is not None]
print('pass mechanical checks:', len(mech), '| unfaithful among them:', sum(1 for r in mech if r['faithful'] is False))
