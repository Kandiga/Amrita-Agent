import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { paths, ensureHome } from '../shared/paths.ts';
import { now, slugify } from '../shared/util.ts';
import { scaffoldVault } from '../core/memory/vault.ts';

function projectFile(slug: string): string {
  return join(paths.project(slug), 'project.json');
}

export function listProjects(): Project[] {
  ensureHome();
  if (!existsSync(paths.projects())) return [];
  const out: Project[] = [];
  for (const entry of readdirSync(paths.projects(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = projectFile(entry.name);
    if (existsSync(file)) {
      try {
        out.push(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        // skip corrupt project files; doctor reports them
      }
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getProject(slug: string): Project | null {
  const file = projectFile(slug);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function createProject(name: string, workingDir: string | null = null): Project {
  ensureHome();
  let slug = slugify(name);
  if (getProject(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const project: Project = {
    slug,
    name,
    createdAt: now(),
    workingDir,
    defaultModel: null,
    enabledConnectors: [],
  };
  mkdirSync(paths.project(slug), { recursive: true });
  writeFileSync(projectFile(slug), JSON.stringify(project, null, 2) + '\n', 'utf8');
  scaffoldVault(slug, name);
  return project;
}

export function updateProject(project: Project): void {
  writeFileSync(projectFile(project.slug), JSON.stringify(project, null, 2) + '\n', 'utf8');
}
