# modules/.scaffold

A placeholder so `dependency-cruiser` has a directory to scan.

`npm run depcruise` covers `apps packages modules`. Until Wave 3 adds the
first real module, `modules/` holds only documentation — and
dependency-cruiser fails outright on a path with no scannable files, which is
why `modules` was previously left out of the command.

Leaving it out meant four boundary rules never executed:
`no-cross-module-internals`, `domain-is-pure`,
`domain-has-no-infrastructure-deps`, and the `modules/*/infrastructure` half
of `kysely-is-allowlisted`. No impact while the directory is empty; total
impact on the day Wave 3 lands, which is exactly when nobody would think to
check.

Delete this directory once a real module exists.
