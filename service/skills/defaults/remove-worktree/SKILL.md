---
name: remove-worktree
description: Safely remove a git worktree and clean up its branch.
metadata:
  author: mobile-agent
  version: "2.0"
  icon: commit
---

Safely remove a git worktree, ensuring no work is lost and the repository stays clean.

## Steps

1. **Check the worktree state before removing.** Run `git status` in the worktree directory to look for uncommitted changes, untracked files, or stashed work. If there are unsaved changes, warn the user and ask what they'd like to do — commit, stash, or discard.

2. **Check if the branch is merged.** Run `git branch --merged main` (or the appropriate default branch) from the main worktree to see if this branch's work has been integrated. If the branch is not merged, make sure the user knows they may lose work if the branch is also deleted.

3. **Move to the main repository before removing.** You MUST `cd` to the main repository root (the original clone, not any worktree) before running the remove command. Your current working directory is the worktree you're about to delete — if you don't move out first, every subsequent shell command will fail because the directory no longer exists. Find the main worktree path with `git worktree list` and `cd` there.

4. **Remove the worktree.** Use `git worktree remove <path>`. If it fails because the worktree is dirty, you'll need `--force` — but only after confirming with the user that they're OK losing those changes.

5. **Prune stale worktree references.** Run `git worktree prune` to clean up any dangling worktree metadata. This is especially helpful if directories were manually deleted without going through `git worktree remove`.

6. **Delete the branch if merged.** If the branch was fully merged, delete it with `git branch -d <branch>`. If it wasn't merged but the user wants it gone, use `git branch -D <branch>` — but confirm first.

7. **Handle common issues:**
   - If the worktree directory has already been manually deleted, `git worktree prune` will clean up the reference.
   - Never remove the main worktree (the original clone). If asked, explain why this isn't possible.
   - If your shell dies mid-removal (e.g., you forgot to `cd` out), start a new shell, `cd` to the main repo, and run `git worktree prune` to clean up.

8. **Report back.** Confirm what was removed and whether the branch was deleted. List any remaining worktrees with `git worktree list` so the user can see the current state.
