// Project registry and git worktree management.
// Stores registered project paths in ~/.mobile-agent/projects.json.
// Only whitelisted projects are accessible from the mobile app.
//
// Follows the same pattern as sessions.js / auth.js.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { logAudit } from './auth.js';

const DATA_DIR = join(process.env.HOME, '.mobile-agent');
const PROJECTS_PATH = join(DATA_DIR, 'projects.json');

// Common icon file locations to scan (checked in order, first match wins)
const ICON_CANDIDATES = [
  'favicon.png',
  'favicon.ico',
  'icon.png',
  'logo.png',
  'logo.svg',
  'public/favicon.png',
  'public/favicon.ico',
  'public/icon.png',
  'public/logo.png',
  'static/favicon.png',
  '.github/logo.png',
  'assets/icon.png',
];

const MAX_ICON_SIZE = 32 * 1024; // 32KB limit for base64 icons

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

  return worktrees
    .filter(wt => !wt.bare)
    .map(wt => ({
      path: wt.path,
      branch: wt.branch || '(unknown)',
      isMain: wt.path === project.path,
    }));
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
 * @param {string} projectPath
 * @returns {string|null} Data URI or null if no icon found
 */
export function getProjectIcon(projectPath) {
  for (const candidate of ICON_CANDIDATES) {
    const iconPath = join(projectPath, candidate);
    try {
      if (!existsSync(iconPath)) continue;

      const stat = statSync(iconPath);
      if (!stat.isFile() || stat.size > MAX_ICON_SIZE) continue;

      const data = readFileSync(iconPath);
      const ext = candidate.split('.').pop().toLowerCase();

      let mime;
      if (ext === 'png') mime = 'image/png';
      else if (ext === 'ico') mime = 'image/x-icon';
      else if (ext === 'svg') mime = 'image/svg+xml';
      else if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
      else continue;

      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      continue;
    }
  }
  return null;
}

// --- Persistence ---

function writeProjects() {
  const data = JSON.stringify({ projects, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(PROJECTS_PATH, data, { mode: 0o600 });
}
