# Rebase current work onto the updated remote base

Carry out this workflow using the current session's tools. Follow repository
instructions and any additional scope supplied with this command. Preserve local
work and resolve conflicts, not just propose commands or stop after rebasing.

## Inspect and discover

1. Run `jj st`, `jj diff`, and `jj git remote list` in the target repository.
   Inspect the current stack and record the original working-copy change ID and
   operation ID for recovery. Preserve uncommitted changes without stashing,
   discarding, or committing them. Do not initialize a repository or switch to
   Git's rebase workflow if this is not a Jujutsu repository.
2. Identify the GitHub repository and host from the selected remote's URL. Use
   the user-specified remote, otherwise `origin` when present. Resolve ambiguous
   remotes before mutating anything. Use explicit repository paths in `gh api`
   requests, with `--hostname` for that host, so gh cannot silently choose a
   fork's upstream instead of the selected remote.
3. Use `gh api repos/<owner>/<repo>` to read `fork`, `default_branch`, and, for
   a fork, `parent.full_name` and `parent.default_branch`. Do not infer fork
   status from remote names. Choose the remote repository's actual default
   branch if it is `main` or `master`. Otherwise inspect its branches through
   `gh api`: choose the sole existing `main`/`master`, or ask if both or neither
   exist. Check that the chosen branch exists. An authentication, network, or
   API failure is not evidence that a repository is not a fork or a branch is
   absent.

## Sync the fork before fetching locally

4. If `fork` is true, inspect the parent repository's branches through `gh api`.
   Use the same branch name upstream when it exists. If upstream renamed that
   branch, use its actual `main`/`master` default branch after confirming it
   exists. Resolve any remaining ambiguity before syncing. Read the latest
   upstream branch SHA with `gh api repos/<parent>/branches/<upstream-branch>`.
5. Sync that upstream SHA into the fork's chosen base branch on GitHub, before
   any local fetch. Use the non-destructive merge API so differing `main` and
   `master` names are handled explicitly:

   ```sh
   gh api --method POST repos/<owner>/<repo>/merges \
     -f base=<fork-branch> -f head=<upstream-sha>
   ```

   Include the selected host in this request too. A successful merge or an
   already-up-to-date response is acceptable. Verify through `gh api` that the
   fork branch contains the upstream SHA, for example with
   `repos/<owner>/<repo>/compare/<upstream-sha>...<fork-branch>` reporting
   `ahead` or `identical`. Preserve fork-only commits. Do not force-update refs,
   reset the fork, push local changes, or fall back to a stale base. If syncing
   is denied, conflicts on GitHub, or has an uncertain outcome, inspect the
   remote state and resolve the blocker before fetching or rebasing. Ask when
   resolution requires additional permission or a destructive choice.
6. For a non-fork, skip fork synchronization. Only after the fork is confirmed
   synced, or confirmed not a fork, run `jj git fetch --remote <remote>`.
   Resolve the freshly fetched `<branch>@<remote>` to its full commit ID.
   Confirm it matches the selected remote branch's current SHA. Do not use a
   stale local bookmark or an assumed `master@origin` as the destination.

## Rebase and resolve every conflict

7. Inspect `<base-id>..@` and record its change IDs. This is the current local
   stack, including working-copy changes, not just the tip. Rebase it with
   `jj rebase -r '<base-id>..@' -d <base-id>` to preserve dependencies between
   those commits. If it is empty, report that the work is already up to date.
   Do not force immutable history, abandon commits, or silently widen the scope
   to unrelated stacks. Inspect actual state after any failure before acting.
8. Find conflicts across all affected changes with `jj log` and `conflicts()`,
   and inspect each conflicted revision with `jj resolve --list -r <change-id>`.
   A successful `jj rebase` exit does not mean there are no conflicts. Work from
   oldest conflicted ancestor to newest descendant. Use `jj edit <change-id>`
   and edit conflicted files, or a supported `jj resolve -r <change-id>` merge
   tool. Understand both sides and preserve the intended local behavior while
   integrating upstream changes. Never blanket-select ours/theirs or remove
   markers without resolving their content. Snapshot each resolution with
   `jj st` so descendants update, then recheck affected revisions for conflicts.
9. Return to the original working-copy change ID with `jj edit <original-id>`.
   Repeat resolution until every affected revision is conflict-free, including
   ancestors, and confirm the updated base is an ancestor of the current work.
   Run checks appropriate to the resolved code. Finish with `jj st` and a graph
   of the rebased stack. Report the remote and base branch, fork sync outcome,
   destination commit, resolved conflicts, and checks actually run. Do not claim
   completion while conflicts remain. If intent cannot be determined safely, ask
   for the missing decision and state exactly which conflicts are unresolved.

Invoking this command authorizes the fork-base sync described above, not pushing
local work, force-syncing the fork, or modifying pull requests.
