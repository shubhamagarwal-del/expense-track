/**
 * build.js — Vercel pre-deployment build script
 * Copies all static assets from root → public/
 * Run via: node build.js  (or "npm run build")
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const OUT = 'public';

// Static file extensions to copy
const EXTS = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.txt']);

// Root-level directories / files to skip
const SKIP = new Set(['node_modules', '.vercel', '.git', '.claude', 'api', 'migration', 'public', 'build.js', 'server.js', 'package.json', 'package-lock.json', 'vercel.json', 'nodemon.json']);

// Subdirectories to copy recursively (whitelist)
const COPY_DIRS = ['logo'];

mkdirSync(OUT, { recursive: true });

let copied = 0;

// Copy root-level static files
for (const name of readdirSync('.')) {
  if (SKIP.has(name)) continue;
  const stat = statSync(name);
  if (stat.isFile() && EXTS.has(extname(name).toLowerCase())) {
    copyFileSync(name, join(OUT, name));
    copied++;
    console.log(`  ✓ ${name}`);
  }
}

// Copy whitelisted subdirectories
for (const dir of COPY_DIRS) {
  try {
    const files = readdirSync(dir);
    mkdirSync(join(OUT, dir), { recursive: true });
    for (const file of files) {
      if (EXTS.has(extname(file).toLowerCase())) {
        copyFileSync(join(dir, file), join(OUT, dir, file));
        copied++;
        console.log(`  ✓ ${dir}/${file}`);
      }
    }
  } catch { /* directory doesn't exist — skip */ }
}

console.log(`\nBuild complete — ${copied} files copied to /${OUT}`);
