export interface Repo { isLocked(id: string): Promise<boolean> }

// @vantle: "Q"
export async function check(repo: Repo, lockEverything: () => Promise<void>, id: string, force: boolean): Promise<string> {
  if (await repo.isLocked(id)) return 'locked'
  if (force) await lockEverything()
  if (await repo.isLocked(id)) return 'now locked'
  return 'open'
}
