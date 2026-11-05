# Usable count after the size round: the latest verdict for each of the 60 charts.
# Run from this folder: python3 rescore.py
# summaries/ holds this round's final extraction. Charts that pass the mechanical checks and
# changed visibly since the last extraction (rerun-1/summaries) were re-reviewed blind,
# listed in todo.json, verdicts in review/ (brief: review-brief.md). Two label fixes landed
# after that review and changed labels only (no box, arrow or path count) in 9 reviewed
# charts; the one verdict that hinged on a label was judged again, in rereview/. Every other chart that passes keeps its latest
# verdict from rerun-1 (rounds 2-5) or the first review. Charts that fail the mechanical
# checks count as unusable without review.
import json, glob, collections, os
R1 = '../rerun-1'
def load(d):
    out = {}
    for f in glob.glob(f'{d}/*.json'):
        for r in json.load(open(f)): out[(r['repo'], int(r['rank']))] = r
    return out
# rerun-1's own rescore output holds the latest verdict per chart before this round.
before = {(r['repo'], int(r['rank'])): r for r in json.load(open(f'{R1}/a-rescore.json'))}
review = load('review')
# Charts re-judged after the label fixes that followed the review (only Vendure #2's verdict hinged on a label).
review.update(load('rereview'))
todo = {(x.rsplit('#', 1)[0], int(x.rsplit('#', 1)[1])) for x in json.load(open('todo.json'))}
rows = []
for key, old in sorted(before.items()):
    repo, rank = key
    try:
        chart = next(c for c in json.load(open(f'summaries/{repo}.json'))['charts'] if c['rank'] == rank)
    except (FileNotFoundError, StopIteration):
        chart = None
    if chart is None:
        rows.append({**old, 'before': old['after'], 'after': old['after'], 'deadOnly': False, 'src': 'rerun-1'}); continue
    if not chart.get('mechanical'):
        boxes = chart.get('boxes') or 0
        cat = 'too-big' if boxes > 50 else ('long-labels' if boxes >= 2 else old['category'])
        if chart.get('error'): cat = old['category']
        rows.append({'repo': repo, 'rank': rank, 'before': old['after'], 'after': False, 'category': cat, 'faithful': None, 'deadOnly': False, 'src': 'mechanical', 'boxes': boxes}); continue
    if key in todo:
        v = review[key]
        rows.append({'repo': repo, 'rank': rank, 'before': old['after'], 'after': v['usable'], 'category': v['category'], 'faithful': v.get('faithful'), 'deadOnly': bool(v.get('deadArrowOnly')) and v.get('mainDecision', True), 'src': 'review', 'boxes': chart.get('boxes')})
    else:
        rows.append({**old, 'before': old['after'], 'deadOnly': False, 'src': 'kept', 'boxes': chart.get('boxes')})
# Twenty's scan didn't finish, so its three charts were never extracted or reviewed.
rows += [{'repo': 'twentyhq_twenty', 'rank': k, 'before': False, 'after': False, 'category': 'scan-timeout', 'faithful': None, 'deadOnly': False, 'src': 'rerun-1', 'boxes': None} for k in (1, 2, 3)]
json.dump(rows, open('rescore.json', 'w'), indent=1)
lenient = sum(r['after'] or r['deadOnly'] for r in rows)
print('charts', len(rows), '| usable before', sum(r['before'] for r in rows), '| after', sum(r['after'] for r in rows), '| counting dead arrows as noise', lenient)
print('became usable:', [(r['repo'], r['rank']) for r in rows if r['after'] and not r['before']])
print('stopped being usable:', [(r['repo'], r['rank'], r['category'], r.get('boxes')) for r in rows if r['before'] and not r['after']])
print('main reasons now:', collections.Counter(r['category'] for r in rows if not r['after']).most_common())
mech = [r for r in rows if r['src'] in ('review', 'kept') and r.get('boxes') is not None]
print('pass mechanical checks:', len(mech), '| unfaithful among them:', sum(1 for r in mech if r.get('faithful') is False), '| dead arrows only:', sum(1 for r in mech if r['deadOnly']))
