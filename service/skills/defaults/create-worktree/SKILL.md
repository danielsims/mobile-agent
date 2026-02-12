---
name: create-worktree
description: Creates a new git worktree and opens it in a separate Cursor window. Use when the user wants to work on multiple branches simultaneously, spin up a new worktree, or start work on a feature in isolation.
metadata:
  author: mobile-agent
  version: "1.0"
  icon: commit
---

When the user asks you to create a worktree, do the following:

1. **Parse the request** to identify:
   - The branch name (e.g., `feat/landing-page-updates`)
   - The port number (default to 3001 if not specified)

2. **Create the worktree** using this pattern:
   ```bash
   # From the current repo
   BRANCH="feat/branch-name"
   DIR_NAME="${BRANCH##*/}"  # strips the prefix
   WORKTREE_PATH="/Users/danielsims/Documents/Development/video-creator-$DIR_NAME"

   # Try creating new branch first, fall back to existing branch
   git worktree add "$WORKTREE_PATH" -b "$BRANCH" 2>/dev/null || git worktree add "$WORKTREE_PATH" "$BRANCH"
   ```

3. **Open Cursor** pointing at the new worktree:
   ```bash
   cursor "$WORKTREE_PATH"
   ```

4. **Tell the user** what you did and remind them to run the dev server on the specified port:
   ```
   PORT=3001 pnpm dev
   ```

If the user just gives a feature name like "landing page updates", infer a reasonable branch name like `feat/landing-page-updates`.

To remove a worktree later, run:
```bash
git worktree remove /path/to/worktree
```
