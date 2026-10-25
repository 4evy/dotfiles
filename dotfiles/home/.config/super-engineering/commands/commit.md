# Commit changes by domain

Review the current working-copy changes and commit them by domain using Jujutsu.
Carry out the commits, not just a proposed plan. Follow repository instructions
and any additional scope supplied with this command.

1. Run `jj diff` and `jj st` in the target repository before making changes.
   Read the full diff, including added files, and inspect relevant surrounding
   code to understand intent and catch accidental changes. If the output is
   truncated, inspect the remaining changes before planning commits. If this is
   not a Jujutsu repository, report that and stop rather than falling back to
   Git or initializing a repository. If there are no changes, report that and
   do not create an empty commit.
2. Identify distinct domains by purpose, not just directory or file type.
   Group each behavior change with its related tests, documentation, and
   generated files. Keep unrelated changes separate, even when they share a
   file. Order commits so dependencies come first. Briefly state the domains
   and intended commit subjects before committing. Resolve unclear ownership
   or scope before including questionable changes. Do not silently discard,
   rewrite, or include unrelated work outside the requested scope. Stop for
   unresolved conflicts or suspected secrets rather than committing them.
3. Use `jj commit -m "scope: summary" -- <paths-or-filesets>` for each domain,
   following repository commit-message conventions where they differ. Select
   only that domain's changes. Path selection commits whole changed files, so
   for unrelated hunks within one file use `jj commit --interactive` with a
   supported diff editor to select only the intended hunks. If safe hunk
   selection is unavailable, ask how to proceed instead of combining domains
   or temporarily overwriting files. Do not substitute `git commit`,
   `jj describe`, `jj squash`, or `jj split` for `jj commit`. Use an unscoped
   `jj commit` only when every remaining change belongs to that one domain.
4. After each commit, inspect `jj st` and `jj diff` before selecting the next
   domain. Confirm the created commit contains only its intended changes and
   that the remaining changes are preserved. If a command fails or its outcome
   is uncertain, inspect the actual state before taking another action. Do not
   blindly repeat a commit command. Finish with `jj st` and report the created
   commit IDs, subjects, and any remaining changes or blockers.

Do not push, move bookmarks, or rewrite existing history as part of this
command.
