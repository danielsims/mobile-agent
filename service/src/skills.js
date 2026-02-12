// Skills module — loads SKILL.md files from:
//   1. Built-in defaults (service/skills/defaults/)
//   2. User's ~/.mobile-agent/skills/
//   3. Claude Code's ~/.claude/skills/ (picks up skills installed via `npx skills add`)
//
// Follows the Agent Skills open standard (agentskills.io):
//   skill-name/
//     SKILL.md   — YAML frontmatter + markdown body
//     scripts/   — optional
//     references/— optional
//     assets/    — optional

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = join(process.env.HOME, '.mobile-agent');
const USER_SKILLS_DIR = join(DATA_DIR, 'skills');
const CLAUDE_SKILLS_DIR = join(process.env.HOME, '.claude', 'skills');
const BUILTIN_SKILLS_DIR = join(__dirname, '..', 'skills', 'defaults');

/**
 * Parse SKILL.md content into frontmatter fields and body.
 * Handles simple YAML frontmatter between --- delimiters.
 */
function parseSkillMd(content) {
  const frontmatter = {};
  let body = content;

  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const yamlBlock = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 3).trim();

      // Simple YAML parser for flat key-value, nested metadata, and multi-line values
      let currentKey = null;
      let inMetadata = false;

      for (const line of yamlBlock.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Indented continuation line — append to current key or metadata
        if (line.startsWith('  ')) {
          if (inMetadata) {
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx !== -1) {
              if (!frontmatter.metadata) frontmatter.metadata = {};
              const k = trimmed.slice(0, colonIdx).trim();
              const v = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
              frontmatter.metadata[k] = v;
            }
          } else if (currentKey && currentKey !== 'metadata') {
            // Multi-line value continuation (e.g. description spanning multiple lines)
            const prev = frontmatter[currentKey] || '';
            frontmatter[currentKey] = prev ? prev + ' ' + trimmed : trimmed;
          }
          continue;
        }

        inMetadata = false;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');

          if (key === 'metadata' && !value) {
            inMetadata = true;
            currentKey = key;
          } else {
            frontmatter[key] = value;
            currentKey = key;
          }
        }
      }
    }
  }

  return { frontmatter, body };
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md.
 * Returns an array of { name, description, metadata, icon, body, path }.
 */
function scanSkillsDir(dir) {
  const skills = [];
  if (!existsSync(dir)) return skills;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Follow symlinks — npx skills add creates symlinks in ~/.claude/skills/
      const isDir = entry.isDirectory() ||
        (entry.isSymbolicLink() && (() => { try { return statSync(join(dir, entry.name)).isDirectory(); } catch { return false; } })());
      if (!isDir) continue;

      const skillMdPath = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        const { frontmatter, body } = parseSkillMd(content);

        skills.push({
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '',
          metadata: frontmatter.metadata || {},
          icon: frontmatter.metadata?.icon || (frontmatter.metadata?.author === 'vercel' ? 'vercel' : null),
          body,
          path: skillMdPath,
          source: dir === BUILTIN_SKILLS_DIR ? 'builtin' : 'user',
        });
      } catch (e) {
        console.error(`[Skills] Failed to parse ${skillMdPath}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[Skills] Failed to scan ${dir}:`, e.message);
  }

  return skills;
}

/**
 * Ensure the user skills directory exists.
 */
export function initSkills() {
  try {
    if (!existsSync(USER_SKILLS_DIR)) {
      mkdirSync(USER_SKILLS_DIR, { recursive: true, mode: 0o700 });
    }
  } catch (e) {
    console.error('[Skills] Failed to create skills directory:', e.message);
  }
}

/**
 * List all available skills (built-in + user).
 * Returns metadata only (name, description, icon, source) — no body content.
 */
export function listSkills() {
  const builtinSkills = scanSkillsDir(BUILTIN_SKILLS_DIR);
  const claudeSkills = scanSkillsDir(CLAUDE_SKILLS_DIR);
  const userSkills = scanSkillsDir(USER_SKILLS_DIR);

  // Later sources override earlier ones with the same name:
  // built-in → claude-code installed → mobile-agent user
  const skillMap = new Map();
  for (const skill of builtinSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of claudeSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of userSkills) {
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values()).map(s => ({
    name: s.name,
    description: s.description,
    icon: s.icon,
    source: s.source,
    body: s.body,
  }));
}

/**
 * Get the full content of a skill by name.
 * Returns { name, description, icon, source, body } or null if not found.
 */
export function getSkill(name) {
  // Check highest-priority first: user → claude-code → built-in
  for (const dir of [USER_SKILLS_DIR, CLAUDE_SKILLS_DIR, BUILTIN_SKILLS_DIR]) {
    const skills = scanSkillsDir(dir);
    const match = skills.find(s => s.name === name);
    if (match) {
      return {
        name: match.name,
        description: match.description,
        icon: match.icon,
        source: match.source,
        body: match.body,
      };
    }
  }
  return null;
}

/**
 * Update the body of a skill. Only works for built-in and user skills
 * (not claude-code installed skills, which are managed externally).
 * Rewrites the SKILL.md file preserving frontmatter but replacing the body.
 */
export function updateSkill(name, newBody) {
  // Find the skill file in editable directories
  for (const dir of [USER_SKILLS_DIR, BUILTIN_SKILLS_DIR]) {
    const skills = scanSkillsDir(dir);
    const match = skills.find(s => s.name === name);
    if (match) {
      const content = readFileSync(match.path, 'utf-8');
      // Preserve the frontmatter, replace the body
      const endIdx = content.indexOf('---', 3);
      if (endIdx !== -1) {
        const frontmatterSection = content.slice(0, endIdx + 3);
        const updated = frontmatterSection + '\n\n' + newBody.trim() + '\n';
        writeFileSync(match.path, updated, 'utf-8');
      } else {
        // No frontmatter — just write the body
        writeFileSync(match.path, newBody.trim() + '\n', 'utf-8');
      }
      return getSkill(name);
    }
  }
  return null;
}

/**
 * Search for skills via `npx skills find <query>`.
 * Parses the CLI output into structured results.
 */
export async function searchSkills(query) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync('npx', [
      'skills', 'find', query,
    ], {
      cwd: process.env.HOME,
      timeout: 30000,
      env: { ...process.env },
    });

    // Strip ANSI escape codes
    const clean = stdout.replace(/\x1B\[[0-9;]*m/g, '');
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);

    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Package refs look like "owner/repo@skill"
      if (line.includes('/') && line.includes('@') && !line.startsWith('http') && !line.startsWith('└') && !line.startsWith('Install')) {
        const packageRef = line;
        const urlLine = lines[i + 1];
        const url = urlLine?.startsWith('└') ? urlLine.replace('└', '').trim() : '';
        // Extract skill name from packageRef (part after @)
        const atIdx = packageRef.lastIndexOf('@');
        const name = atIdx !== -1 ? packageRef.slice(atIdx + 1) : packageRef;
        results.push({ name, packageRef, url, description: '' });
      }
    }

    return { success: true, results };
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }
}

/**
 * Install a skill by running `npx skills add <package>`.
 */
export async function installSkill(packageRef) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync('npx', [
      'skills', 'add', packageRef, '-y',
    ], {
      cwd: process.env.HOME,
      timeout: 60000,
      env: { ...process.env },
    });
    return { success: true, output: stdout || stderr };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
