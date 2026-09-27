/*
 * A tiny glob matcher, purpose-built for the patterns in risk-tiers.json:
 * literal segments, `*` (any characters except `/`), and `**` (any number of
 * path segments, including zero).
 *
 * No dependency is added for this. picomatch/minimatch/micromatch are only
 * ever transitive dependencies of this repository's devDependencies, not
 * direct ones, and OPS-002 asks for no new direct dependency when a handful
 * of lines will do. This covers exactly the syntax risk-tiers.json uses — it
 * is not a general-purpose glob engine and does not need to be.
 *
 * Supported:
 *   *      any run of characters except '/'
 *   **     any number of path segments, including none — 'a/**\/b' matches
 *          'a/b' as well as 'a/x/y/b'
 *   ?      is NOT special; it is a literal character (no pattern here uses it)
 *   .      and other regex metacharacters are escaped — they are literal
 */

const SPECIAL = new Set('.+^${}()|[]\\')

/** @param {string} glob */
export function globToRegExp(glob) {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i += 2
      if (glob[i] === '/') {
        // '**/' — zero or more whole path segments, including none.
        re += '(?:.*/)?'
        i += 1
      } else {
        // trailing '**' — anything at all, including nothing.
        re += '.*'
      }
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (SPECIAL.has(c)) {
      re += '\\' + c
      i += 1
      continue
    }
    re += c
    i += 1
  }
  return new RegExp('^' + re + '$')
}

/**
 * @param {string} filePath repo-relative, forward-slash separated
 * @param {readonly string[]} globs
 */
export function matches(filePath, globs) {
  return globs.some((g) => globToRegExp(g).test(filePath))
}

/**
 * @param {readonly string[]} filePaths
 * @param {readonly string[]} globs
 */
export function matchesAny(filePaths, globs) {
  return filePaths.some((f) => matches(f, globs))
}
