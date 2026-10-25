// What a member may look at, and what it must say it did not.
//
// A member asked to check something broadly will happily walk into the folders
// that hold the team's credentials - ~/.dsh, secrets.json, a .env - and then
// report on the whole area as if it had seen all of it. Both halves are wrong:
// the keys are not the work, and "I checked the folder" is not true of a place
// it was never allowed to open.
//
// So a scan has two obligations. It refuses the places that hold secrets,
// wherever they sit, and it says which places those were - a gap named out
// loud, so a reader knows the report covers what was covered and no more.
const SECRET_MARK = /(^|[\\/.])(secrets?\.json|\.dsh|credentials?\.ya?ml|\.credentials|\.env(\.[a-z]+)?|id_rsa|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|token\.json|api[-_.]?key)([\\/.]|$)/i

export const secretish = path => SECRET_MARK.test(String(path ?? '').replace(/\\/g, '/'))

export function install(rt) {
  // True when a path holds credentials and is therefore out of bounds for any
  // scan, however legitimate the rest of the request is.
  const isSecretPath = path => secretish(path)

  // What a request can actually cover: the roots ds-bot can vouch for, and
  // what it had to leave out. The gap sentence is the part a reader needs -
  // without it, "I checked it" reads as "I saw everything".
  function scanScope(paths, roots) {
    // Windows paths compare odd against a `/` prefix, so both sides are read
    // with one separator before anything is said to be inside anything.
    const flat = value => String(value ?? '').replace(/\\/g, '/')
    const asked = (paths ?? []).map(String)
    const allowed = (roots ?? []).filter(Boolean).map(String)
    const covered = []
    const skipped = []
    for (const path of asked) {
      if (isSecretPath(path)) { skipped.push({ path, why: '该路径存放凭据' }); continue }
      if (allowed.length === 0) { skipped.push({ path, why: '本群尚未配置工作目录' }); continue }
      const inner = flat(path)
      const held = allowed.some(root => {
        const outer = flat(root)
        return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
      })
      if (held) covered.push(path)
      else skipped.push({ path, why: '不在本群的工作目录内' })
    }
    const gap = skipped.length === 0
      ? ''
      : `未覆盖（${skipped.length} 项）：${skipped.map(item => `${item.path} — ${item.why}`).join('；')}。以上结论仅覆盖已覆盖的范围。`
    return { covered, skipped, gap }
  }

  Object.assign(rt, { isSecretPath, secretish, scanScope })
}
