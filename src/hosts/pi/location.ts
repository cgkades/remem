import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import type { HostLocation } from "../opencode/shared.js"

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 5_000 }, (error: Error | null, stdout: string) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })
}

function hashOf(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 32)
}

/**
 * Pi's `ExtensionContext` has no built-in equivalent of OpenCode's
 * `context.location.project` (see `src/hosts/opencode/v2.ts` `hostLocation()`
 * and `src/hosts/opencode/v1.ts` `locationFor()`). This derives the same
 * three `HostLocation` fields for Pi:
 *
 * - `directory`: the current working directory Pi reports (`ctx.cwd`),
 *   i.e. the specific worktree the session is running in.
 * - `worktree`: the git worktree root for `cwd` (`git rev-parse
 *   --show-toplevel`), or `cwd` itself when not inside a git repository.
 *   This can differ from `directory` when `cwd` is a subdirectory of the
 *   worktree.
 * - `projectId`: a stable hash of the *shared* git directory (`git
 *   rev-parse --git-common-dir`, resolved to an absolute path), not the
 *   worktree root. Using the common git dir means every linked worktree of
 *   the same repository resolves to the same `projectId`, matching how
 *   `MemoryScope: "project"` is expected to behave across worktrees/sessions
 *   (see `src/types.ts` `MemoryScope`). Outside a git repository, `cwd` is
 *   hashed instead so behavior degrades gracefully rather than throwing.
 *
 * This scheme is documented for operators in `docs/pi-integration.md`.
 */
export async function deriveHostLocation(cwd: string): Promise<HostLocation> {
  const resolvedCwd = path.resolve(cwd)

  let worktree = resolvedCwd
  try {
    const toplevel = await git(["rev-parse", "--show-toplevel"], resolvedCwd)
    if (toplevel) worktree = path.resolve(toplevel)
  } catch {
    // Not inside a git repository (or git is unavailable): fall back to cwd.
  }

  let projectIdentity = resolvedCwd
  try {
    const commonDir = await git(["rev-parse", "--git-common-dir"], resolvedCwd)
    if (commonDir) projectIdentity = path.resolve(resolvedCwd, commonDir)
  } catch {
    // Not inside a git repository (or git is unavailable): fall back to cwd.
  }

  return { directory: resolvedCwd, worktree, projectId: hashOf(projectIdentity) }
}
