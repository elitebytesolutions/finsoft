/*
 * Next's ambient types, in a TRACKED file.
 *
 * Next generates `next-env.d.ts` on `next dev` / `next build`, and that file
 * is gitignored (.gitignore:10) — correctly, since it is build output. But it
 * carries the reference that types a static image import as `StaticImageData`
 * rather than `string`. So `npm run typecheck` passed on any machine that had
 * run the dev server, and failed on a clean clone.
 *
 * CI found it on its first run: `parties.tsx(13,46): Property 'src' does not
 * exist on type 'string'`, against a working copy byte-identical to HEAD. A
 * gate that only passes on a machine which has already built is not a gate.
 *
 * These two references resolve inside `node_modules/next`, which `npm ci`
 * always produces. Deliberately NOT included is next-env.d.ts's third line,
 * `/// <reference path="./.next/types/routes.d.ts" />` — that points at real
 * build output, and referencing a missing path is itself an error.
 *
 * This file must sit at the app root, next to next-env.d.ts. Placed in a
 * subdirectory the `reference types=` lookup for the `next/image-types/global`
 * subpath does not resolve, the declarations silently do not apply, and the
 * image import degrades back to `string` — verified both ways.
 *
 * It does not replace next-env.d.ts. Next regenerates that locally and the
 * duplicate reference is harmless.
 */

/// <reference types="next" />
/// <reference types="next/image-types/global" />
