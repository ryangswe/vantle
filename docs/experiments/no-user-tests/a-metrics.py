import json,glob,collections,sys,os
S=sys.argv[1]
rows=[]
for f in sorted(glob.glob(f'{S}/a-review/*.json')):
    rows+= json.load(open(f))
for r in range(1,4): rows.append(dict(repo='twentyhq_twenty',rank=r,function='(scan did not finish)',usable=False,category='scan-timeout',alsoCategories=[],mechanical=False))
repos=sorted(set(r['repo'] for r in rows))
u=[r for r in rows if r['usable']]
print(f'charts {len(rows)} in {len(repos)} repos; usable {len(u)} = {len(u)/len(rows):.0%}')
print('repos with >=1 usable:', sum(1 for x in repos if any(r['usable'] for r in rows if r['repo']==x)))
print('by category:', collections.Counter(r['category'] for r in rows if not r['usable']).most_common())
allc=collections.Counter()
for r in rows:
    if not r['usable']:
        for c in set([r['category']]+(r.get('alsoCategories') or [])): allc[c]+=1
print('any mention:', allc.most_common())
mech=[r for r in rows if r.get('mechanical')]
print(f"mechanical pass {len(mech)}; of those usable {sum(r['usable'] for r in mech)}; unfaithful among mechanical: {sum(1 for r in mech if r.get('faithful') is False)}")
struct={'scan-timeout'} 
excl=[r for r in rows if r['repo'] not in ('twentyhq_twenty','logto-io_logto','bluesky-social_atproto')]
print(f"excluding twenty/logto/atproto (package or scan problems): {sum(r['usable'] for r in excl)}/{len(excl)} = {sum(r['usable'] for r in excl)/len(excl):.0%}")
for x in repos: print(f"  {x:28} {''.join('Y' if r['usable'] else '.' for r in sorted([r for r in rows if r['repo']==x], key=lambda r:r['rank']))}  {[r['category'] for r in sorted([r for r in rows if r['repo']==x], key=lambda r:r['rank'])]}")
