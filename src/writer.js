// Writes the file map to disk, recursively creating directories. Paths were vetted
// by policy.js already; the checks here hold regardless of who called this module,
// and also cover symlinks that exist on disk when --force targets an old directory.

import { existsSync, readdirSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILLER = /^(please\s+)?((build|create|make|generate|write|design|code)\s+)?((me|us)\s+)?((a|an|the|my)\s+)?/i;

/** "Build a collaborative to-do list" becomes "collaborative-to-do-list". */
export function slugify(prompt) {
  const slug = prompt
    .replace(FILLER, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return slug || 'ignite-app';
}

const isOccupied = (dir) => existsSync(dir) && readdirSync(dir).length > 0;

export function resolveProjectDir(prompt, { dir, force = false, cwd = process.cwd() } = {}) {
  if (dir) {
    const root = path.resolve(cwd, dir);
    if (isOccupied(root) && !force) {
      throw new Error(`${root} is not empty. Choose another --dir, or pass --force to write into it.`);
    }
    return root;
  }

  const base = slugify(prompt);
  let name = base;
  for (let i = 2; isOccupied(path.join(cwd, name)); i += 1) name = `${base}-${i}`;
  return path.join(cwd, name);
}

async function isSymlink(target) {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function writeProject(root, files) {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);

  for (const [file, content] of files) {
    const target = path.resolve(realRoot, file);
    if (!target.startsWith(realRoot + path.sep)) {
      throw new Error(`Refusing to write outside the project: ${file}`);
    }

    // Check each level before mkdir so a symlink cannot redirect the write.
    let current = realRoot;
    for (const segment of path.relative(realRoot, target).split(path.sep)) {
      current = path.join(current, segment);
      if (await isSymlink(current)) throw new Error(`Refusing to write through a symlink: ${current}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
