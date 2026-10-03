import type { ScanAnswer, WorktreeList } from "../src/client/lib/types"

/**
 * A `worktree.scan` answer for tests.
 *
 * The endpoint answers an object - the repositories it found plus whether that is
 * all of them - because a scan that read ninety of a hundred repositories used to
 * throw and take the ninety with it. Writing `{ lists, complete, reason }` by hand
 * in every test is how a shape like that quietly drifts: a mock returning a bare
 * array still type-checks through `any`, and then the test passes while the panel
 * is broken. One constructor, so a change to the shape is a change here.
 *
 * @param lists - the repositories a scan found.
 * @param complete - whether that is everything, defaulting to yes.
 * @param depth - the scan depth the Host reports as in force, which the panel
 *   names while it scans. Defaulted to the shipped setting so a case that does not
 *   care gets the number a real scan would report; a case about the depth itself
 *   passes one and the panel is checked against that.
 * @returns the answer object the API mock resolves to.
 */
export function scanAnswer(lists: WorktreeList[], complete = true, depth = 2): ScanAnswer {
  return { lists, complete, reason: complete ? "" : "Some repositories did not answer the scan and are not shown.", bounds: { depth, directories: 2000 } }
}