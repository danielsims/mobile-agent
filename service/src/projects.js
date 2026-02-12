// Project registry and git worktree management.
// Stores registered project paths in ~/.mobile-agent/projects.json.
// Only whitelisted projects are accessible from the mobile app.
//
// Follows the same pattern as sessions.js / auth.js.

import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { logAudit } from './auth.js';

const DATA_DIR = join(process.env.HOME, '.mobile-agent');
const PROJECTS_PATH = join(DATA_DIR, 'projects.json');

// Icon filenames to search for (checked in order, first match wins)
const ICON_FILENAMES = [
  'favicon.ico',
  'favicon.png',
  'icon.png',
  'logo.png',
  'logo.svg',
];

const MAX_ICON_READ_SIZE = 2 * 1024 * 1024; // 2MB - allow reading large app icons (e.g. Expo 1024x1024)
const ICON_RESIZE_THRESHOLD = 64 * 1024; // Resize icons larger than 64KB before base64 encoding
const ICON_RESIZE_PX = 128; // Resize to 128x128 for display
const ICON_SEARCH_DEPTH = 5; // Max directory depth for recursive search

// Branch name validation: alphanumeric, hyphens, underscores, dots, slashes
const BRANCH_NAME_RE = /^[a-zA-Z0-9_\-./]+$/;

// In-memory state
let projects = {}; // id -> { name, path, registeredAt }

/**
 * Load registered projects from disk. Called on bridge startup.
 */
export function loadProjects() {
  try {
    if (existsSync(PROJECTS_PATH)) {
      const data = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
      projects = data.projects || {};
      logAudit('projects_loaded', { count: Object.keys(projects).length });
    }
  } catch (e) {
    console.error('Failed to load projects:', e.message);
    projects = {};
  }
}

/**
 * Get all registered projects.
 * @returns {Object} id -> { name, path, registeredAt }
 */
export function getProjects() {
  return { ...projects };
}

/**
 * Get a single project by ID.
 * @param {string} projectId
 * @returns {{ name: string, path: string, registeredAt: string } | null}
 */
export function getProject(projectId) {
  return projects[projectId] || null;
}

/**
 * Register a git repository as a project.
 * Validates the path is a git repo and resolves to the repo root.
 * @param {string} inputPath - Path to the repo (resolved to absolute)
 * @param {string} [name] - Optional display name (defaults to directory basename)
 * @returns {{ id: string, name: string, path: string }}
 */
export function registerProject(inputPath, name) {
  const absPath = resolve(inputPath);

  if (!existsSync(absPath)) {
    throw new Error(`Directory does not exist: ${absPath}`);
  }

  const stat = statSync(absPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absPath}`);
  }

  // Resolve to git root
  let gitRoot;
  try {
    gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: absPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    throw new Error(`Not a git repository: ${absPath}`);
  }

  // Check for duplicates
  for (const [id, project] of Object.entries(projects)) {
    if (project.path === gitRoot) {
      throw new Error(`Already registered as "${project.name}" (${id})`);
    }
  }

  const id = randomBytes(4).toString('hex');
  const projectName = name || basename(gitRoot);

  projects[id] = {
    name: projectName,
    path: gitRoot,
    registeredAt: new Date().toISOString(),
  };

  writeProjects();
  logAudit('project_registered', { id, name: projectName, path: gitRoot });

  return { id, name: projectName, path: gitRoot };
}

/**
 * Remove a registered project.
 * @param {string} projectId
 * @returns {boolean} true if removed
 */
export function unregisterProject(projectId) {
  if (!projects[projectId]) return false;

  const project = projects[projectId];
  delete projects[projectId];
  writeProjects();
  logAudit('project_unregistered', { id: projectId, name: project.name, path: project.path });

  return true;
}

// --- Git Worktree Operations ---

/**
 * List worktrees for a registered project.
 * @param {string} projectId
 * @returns {Array<{ path: string, branch: string, isMain: boolean }>}
 */
export function listWorktrees(projectId) {
  const project = projects[projectId];
  if (!project) throw new Error('Project not found');

  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: project.path,
    encoding: 'utf-8',
    timeout: 5000,
  });

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.branch = '(detached)';
    } else if (line === '') {
      if (current.path) worktrees.push(current);
      current = {};
    }
  }
  if (current.path) worktrees.push(current);

  // Detect which branches are truly merged into main.
  // "Merged" means the branch had unique work that is now reachable from main,
  // NOT just that the branch happens to sit at the same commit as main (freshly created).
  const mainBranch = worktrees.find(wt => wt.path === project.path)?.branch;
  let mergedBranches = new Set();
  let mainRef = null;
  try {
    if (mainBranch) {
      mainRef = execFileSync('git', ['rev-parse', mainBranch], {
        cwd: project.path, encoding: 'utf-8', timeout: 3000,
      }).trim();

      const merged = execFileSync('git', ['branch', '--merged', mainBranch], {
        cwd: project.path, encoding: 'utf-8', timeout: 5000,
      });
      for (const line of merged.split('\n')) {
        const name = line.replace(/^[*+]?\s+/, '').trim();
        if (name && name !== mainBranch) mergedBranches.add(name);
      }
    }
  } catch {
    // If merged check fails, just skip status detection
  }

  return worktrees
    .filter(wt => !wt.bare)
    .map(wt => {
      const branch = wt.branch || '(unknown)';
      const isMain = wt.path === project.path;
      let status = 'active';
      if (isMain) {
        status = 'main';
      } else if (mergedBranches.has(branch)) {
        // Only mark as "merged" if the branch tip differs from main —
        // a branch sitting at the exact same commit as main is just newly created.
        try {
          const branchRef = execFileSync('git', ['rev-parse', branch], {
            cwd: project.path, encoding: 'utf-8', timeout: 3000,
          }).trim();
          status = (branchRef !== mainRef) ? 'merged' : 'active';
        } catch {
          status = 'merged'; // can't resolve, trust git branch --merged
        }
      }
      return { path: wt.path, branch, isMain, status };
    });
}

/**
 * Create a new worktree for a registered project.
 * @param {string} projectId
 * @param {string} branchName
 * @returns {{ path: string, branch: string }}
 */
export function createWorktree(projectId, branchName) {
  const project = projects[projectId];
  if (!project) throw new Error('Project not found');

  if (!BRANCH_NAME_RE.test(branchName)) {
    throw new Error('Invalid branch name. Use alphanumeric characters, hyphens, underscores, dots, and slashes only.');
  }

  // Worktree directory: sibling of project root, named <project>--<branch>
  const sanitizedBranch = branchName.replace(/\//g, '--');
  const worktreeDir = join(dirname(project.path), `${project.name}--${sanitizedBranch}`);

  if (existsSync(worktreeDir)) {
    throw new Error(`Worktree directory already exists: ${worktreeDir}`);
  }

  // Check if branch already exists
  let branchExists = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', branchName], {
      cwd: project.path,
      encoding: 'utf-8',
      timeout: 5000,
    });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  const args = branchExists
    ? ['worktree', 'add', worktreeDir, branchName]
    : ['worktree', 'add', '-b', branchName, worktreeDir];

  execFileSync('git', args, {
    cwd: project.path,
    encoding: 'utf-8',
    timeout: 30000,
  });

  logAudit('worktree_created', { projectId, branchName, path: worktreeDir });

  return { path: worktreeDir, branch: branchName };
}

/**
 * Remove a worktree for a registered project.
 * @param {string} projectId
 * @param {string} worktreePath
 */
export function removeWorktree(projectId, worktreePath) {
  const project = projects[projectId];
  if (!project) throw new Error('Project not found');

  // Validate the path is an actual worktree of this project
  const worktrees = listWorktrees(projectId);
  const wt = worktrees.find(w => w.path === worktreePath);
  if (!wt) throw new Error('Worktree not found for this project');
  if (wt.isMain) throw new Error('Cannot remove the main worktree');

  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: project.path,
    encoding: 'utf-8',
    timeout: 15000,
  });

  logAudit('worktree_removed', { projectId, path: worktreePath });
}

/**
 * Resolve and validate a cwd for agent spawn.
 * @param {string} projectId
 * @param {string} [worktreePath] - Optional worktree path (defaults to main worktree)
 * @returns {string} Validated absolute path
 */
export function resolveProjectCwd(projectId, worktreePath) {
  const project = projects[projectId];
  if (!project) throw new Error('Project not found');

  if (!worktreePath) {
    return project.path;
  }

  // Validate worktree path is actually a worktree of this project
  const worktrees = listWorktrees(projectId);
  const wt = worktrees.find(w => w.path === worktreePath);
  if (!wt) throw new Error('Invalid worktree path for this project');

  return wt.path;
}

// --- Project Icon Detection ---

/**
 * Scan a project directory for a favicon/logo and return as base64 data URI.
 * Searches recursively up to ICON_SEARCH_DEPTH levels deep, skipping
 * node_modules, .git, and other heavy directories.
 * @param {string} projectPath
 * @returns {string|null} Data URI or null if no icon found
 */
export function getProjectIcon(projectPath) {
  // Build a find command that searches for icon filenames, skipping heavy dirs
  const nameArgs = ICON_FILENAMES.flatMap((name, i) =>
    i === 0 ? ['-name', name] : ['-o', '-name', name]
  );

  let matches;
  try {
    const output = execFileSync('find', [
      projectPath,
      '-maxdepth', String(ICON_SEARCH_DEPTH),
      // Skip heavy/irrelevant directories
      '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', 'dist',
            '-o', '-name', 'build', '-o', '-name', '.next', '-o', '-name', 'coverage', ')',
      '-prune', '-o',
      '-type', 'f',
      '(', ...nameArgs, ')',
      '-print',
    ], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    matches = output.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }

  if (matches.length === 0) return null;

  // Prefer shallower paths (closer to project root) and favicon over logo
  matches.sort((a, b) => {
    const depthA = a.split(sep).length;
    const depthB = b.split(sep).length;
    if (depthA !== depthB) return depthA - depthB;
    // Prefer favicon over icon over logo
    const nameA = basename(a).toLowerCase();
    const nameB = basename(b).toLowerCase();
    const priority = (n) => n.startsWith('favicon') ? 0 : n.startsWith('icon') ? 1 : 2;
    return priority(nameA) - priority(nameB);
  });

  // Try each match until we find one that's readable
  for (const iconPath of matches) {
    try {
      const stat = statSync(iconPath);
      if (!stat.isFile() || stat.size > MAX_ICON_READ_SIZE || stat.size === 0) continue;

      const ext = iconPath.split('.').pop().toLowerCase();

      let mime;
      if (ext === 'png') mime = 'image/png';
      else if (ext === 'ico') mime = 'image/x-icon';
      else if (ext === 'svg') mime = 'image/svg+xml';
      else if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
      else continue;

      // Large raster images (e.g. Expo 1024x1024 icons) — resize via macOS
      // sips to a small thumbnail before base64 encoding
      if (stat.size > ICON_RESIZE_THRESHOLD && (ext === 'png' || ext === 'jpg' || ext === 'jpeg')) {
        try {
          const tmpPath = join(tmpdir(), `mobile-agent-icon-${randomBytes(4).toString('hex')}.${ext}`);
          execFileSync('sips', [
            '-z', String(ICON_RESIZE_PX), String(ICON_RESIZE_PX),
            iconPath, '--out', tmpPath,
          ], { timeout: 10000, stdio: 'pipe' });
          const resizedData = readFileSync(tmpPath);
          try { unlinkSync(tmpPath); } catch {}
          return `data:${mime};base64,${resizedData.toString('base64')}`;
        } catch {
          // sips unavailable (non-macOS) — use original
        }
      }

      const data = readFileSync(iconPath);
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      continue;
    }
  }
  return null;
}

// --- Git Status / Diff Queries ---

/**
 * Get git status (changed files) for a working directory.
 * @param {string} cwd - Absolute path to the working directory
 * @returns {Array<{ file: string, status: string }>}
 */
export function getGitStatus(cwd) {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    });

    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const xy = line.slice(0, 2);
        const file = line.slice(3);
        // Porcelain v1: XY where X=index, Y=worktree
        // Untracked files are '??', unmerged are 'UU'/'AA'/'DD' etc.
        // We report a single semantic status matching VS Code's "Changes" view:
        // - If untracked (??) → U (untracked)
        // - If unmerged (U in either col, or DD/AA/AU/UA) → C (conflict)
        // - Prefer worktree status (Y) when present, else index status (X)
        const x = xy[0];
        const y = xy[1];

        let status;
        if (x === '?' && y === '?') {
          status = 'U'; // Untracked
        } else if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) {
          status = 'C'; // Conflict / unmerged
        } else if (y !== ' ') {
          status = y; // Worktree change (unstaged)
        } else {
          status = x; // Index change (staged)
        }

        return { status, file };
      });
  } catch {
    return [];
  }
}

/**
 * Get unified diff for a specific file (or all files if no filePath).
 * @param {string} cwd - Absolute path to the working directory
 * @param {string} [filePath] - Optional file path relative to repo root
 * @returns {string} Raw unified diff output
 */
export function getGitDiff(cwd, filePath) {
  try {
    const args = ['diff', 'HEAD'];
    if (filePath) args.push('--', filePath);

    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch {
    return '';
  }
}

/**
 * Get branch info including ahead/behind counts relative to upstream.
 * @param {string} cwd - Absolute path to the working directory
 * @returns {{ branch: string, ahead: number, behind: number }}
 */
export function getGitBranchInfo(cwd) {
  const result = { branch: '', ahead: 0, behind: 0 };

  try {
    result.branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return result;
  }

  try {
    const counts = execFileSync('git', ['rev-list', '--left-right', '--count', `${result.branch}...@{upstream}`], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const [ahead, behind] = counts.split('\t').map(Number);
    result.ahead = ahead || 0;
    result.behind = behind || 0;
  } catch {
    // No upstream configured — that's fine
  }

  return result;
}

// --- Git Log ---

/**
 * Get structured commit log for a repository.
 * @param {string} cwd - Absolute path to the working directory
 * @param {number} [maxCount=100] - Maximum number of commits
 * @returns {Array<{ hash, abbrevHash, parents, subject, author, relativeTime, refs }>}
 */
export function getGitLog(cwd, maxCount = 100) {
  try {
    const SEP = '\x00';
    const output = execFileSync('git', [
      'log',
      '--all',
      `--max-count=${maxCount}`,
      `--format=%H${SEP}%h${SEP}%P${SEP}%s${SEP}%an${SEP}%ar${SEP}%D`,
    ], {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
    });

    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, abbrevHash, parentStr, subject, author, relativeTime, refStr] = line.split(SEP);
        return {
          hash,
          abbrevHash,
          parents: parentStr ? parentStr.split(' ').filter(Boolean) : [],
          subject,
          author,
          relativeTime,
          refs: refStr ? refStr.split(', ').filter(Boolean) : [],
        };
      });
  } catch {
    return [];
  }
}

// --- Persistence ---

function writeProjects() {
  const data = JSON.stringify({ projects, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(PROJECTS_PATH, data, { mode: 0o600 });
}
