#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

function removeDirSync(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const stat = fs.statSync(dir);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      removeDirSync(path.join(dir, entry));
    }
    try {
      fs.rmdirSync(dir);
    } catch (err) {
      // on Windows, fs.rmdirSync may fail for read-only files; ignore
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err2) {
        console.warn(`Failed to remove dir: ${dir}`, err2.message);
      }
    }
  } else {
    try {
      fs.unlinkSync(dir);
    } catch (e) {
      // ignore
    }
  }
}

function findAndCleanupPlatformBinaryDirs(root, keepPlatform) {
  if (!fs.existsSync(root)) return;
  const plugins = fs.readdirSync(root);
  for (const plugin of plugins) {
    const extPath = path.join(root, plugin, 'extension');
    const binaryBase = path.join(extPath, 'binary_modules');
    if (!fs.existsSync(binaryBase)) continue;
    const versions = fs.readdirSync(binaryBase);
    for (const ver of versions) {
      const entries = fs.readdirSync(path.join(binaryBase, ver));
      for (const entry of entries) {
        if (entry === keepPlatform) continue;
        const removePath = path.join(binaryBase, ver, entry);
        if (fs.existsSync(removePath)) {
          console.log(`Removing ${entry} binary folder for plugin ${plugin}: ${removePath}`);
          removeDirSync(removePath);
        }
      }
    }
  }
}

function removeBuildArtifacts(root) {
  if (!fs.existsSync(root)) return;
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // remove obj directories
        if (entry.name === 'obj') {
          console.log('Removing obj folder:', full);
          removeDirSync(full);
          continue;
        }
        // remove build/Release directories entirely
        if (entry.name === 'build') {
          const releasePath = path.join(full, 'Release');
          if (fs.existsSync(releasePath)) {
            console.log('Removing build Release folder:', releasePath);
            removeDirSync(releasePath);
            continue;
          }
        }
        walk(full);
      } else {
        // remove tlog and lastbuildstate
        if (entry.name.endsWith('.tlog') || entry.name.endsWith('.lastbuildstate')) {
          try {
            fs.unlinkSync(full);
            console.log('Removed artifact file:', full);
          } catch (e) {
            // ignore
          }
        }
      }
    }
  };
  walk(root);
}

function main() {
  // Only run on Windows platform to be safe.
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
    console.log('Skipping cleanup on non-windows/darwin/linux platform.');
    return;
  }
  const projectRoot = path.join(__dirname, '..');
  const pluginsRoot = path.join(projectRoot, 'plugins');
  const keep = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  findAndCleanupPlatformBinaryDirs(pluginsRoot, keep);
  // Remove build artifacts (obj, tlog) which are not needed and cause packaging issues
  removeBuildArtifacts(pluginsRoot);
}

main();
