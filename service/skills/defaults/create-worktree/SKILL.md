---
name: create-worktree
description: Create a new git worktree for parallel branch work.
metadata:
  author: mobile-agent
  version: "2.0"
  icon: commit
---

Create a new git worktree so the user can work on a separate branch in parallel without disturbing their current work.

## Steps

1. **Determine the branch name.** If the user gives a feature description rather than an explicit branch name, derive a clean kebab-case name with an appropriate prefix (e.g. `feat/`, `fix/`, `chore/`).

2. **Validate the branch name.** It must be a valid git ref — no spaces, no `..`, no trailing `.lock`, no control characters. Slashes are fine for namespacing (e.g. `feat/new-dashboard`).

3. **Choose the worktree directory.** Place it alongside the current repo as a sibling directory. Use the pattern `{repo-name}--{sanitized-branch}` where slashes in the branch name become `--`. For example, if the repo is at `/Users/me/projects/my-app` and the branch is `feat/auth`, the worktree goes at `/Users/me/projects/my-app--feat--auth`.

4. **Create the worktree.** Check whether the branch already exists — if it does, attach to it; if not, create it fresh from the current HEAD:
   ```bash
   git worktree add <path> -b <branch>   # new branch
   git worktree add <path> <branch>      # existing branch
   ```

5. **Handle common issues:**
   - If the branch is already checked out in another worktree, tell the user — you can't have the same branch in two worktrees.
   - If the directory already exists, don't blindly overwrite it. Check if it's a valid worktree first (`git worktree list`), and let the user know.
   - If the repo has submodules, remind the user to run `git submodule update --init` in the new worktree.
   - If there's a lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock), suggest running the appropriate install command in the new worktree since `node_modules` aren't shared.

6. **Report back.** Tell the user the worktree path, the branch name, and any next steps (dependency install, dev server, etc.).
