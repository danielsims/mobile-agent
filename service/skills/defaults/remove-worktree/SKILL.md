---
name: remove-worktree
description: Safely remove a git worktree and clean up its branch.
metadata:
  author: mobile-agent
  version: "1.0"
  icon: commit
---

Safely remove a git worktree, ensuring no work is lost and the repository stays clean.

## Steps

1. **Check the worktree state before removing.** Run `git status` in the worktree directory to look for uncommitted changes, untracked files, or stashed work. If there are unsaved changes, warn the user and ask what they'd like to do — commit, stash, or discard.

2. **Check if the branch is merged.** Run `git branch --merged main` (or the appropriate default branch) from the main worktree to see if this branch's work has been integrated. If the branch is not merged, make sure the user knows they may lose work if the branch is also deleted.

3. **Remove the worktree.** Use `git worktree remove <path>`. If it fails because the worktree is dirty, you'll need `--force` — but only after confirming with the user that they're OK losing those changes.

4. **Prune stale worktree references.** Run `git worktree prune` to clean up any dangling worktree metadata. This is especially helpful if directories were manually deleted without going through `git worktree remove`.

5. **Optionally delete the branch.** If the branch was fully merged, offer to delete it with `git branch -d <branch>`. If it wasn't merged but the user wants it gone, use `git branch -D <branch>` — but confirm first.

6. **Handle common issues:**
   - If the worktree directory has already been manually deleted, `git worktree prune` will clean up the reference.
   - Never remove the main worktree (the original clone). If asked, explain why this isn't possible.
   - If other worktrees reference this branch (unlikely but possible with detached HEADs), note the dependency.

7. **Report back.** Confirm what was removed and whether the branch was deleted. List any remaining worktrees with `git worktree list` so the user can see the current state.
