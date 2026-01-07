// @ts-check
'use strict';

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const semver = require('semver');

async function exec(command, args, options) {
  const execa = await import('execa');
  const promise = execa.execa(command, args, options);
  const { stdout } = await promise;
  return stdout;
}

function findFirstDirectory(dirPath, predicate) {
  const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && predicate(entry.name)) {
      return path.join(dirPath, entry.name);
    }
  }
  return undefined;
}

async function getVersion() {
  let version = require('../package.json').version;
  if (!semver.valid(version)) {
    throw new Error(`Invalid version in electron-app/package.json: '${version}'.`);
  }

  // Mirror the versioning behavior from scripts/package.js.
  if (process.env.IS_RELEASE !== 'true') {
    if (process.env.IS_NIGHTLY === 'true') {
      const d = new Date();
      const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      version = `${version}-nightly-${yyyymmdd}`;
    } else {
      const commitish = await exec('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
      });
      version = `${version}-snapshot-${String(commitish).trim()}`;
    }
  }

  return version;
}

function findMakensisExe() {
  // Prefer a user-provided NSIS toolchain.
  const customNsisDir = process.env.ELECTRON_BUILDER_NSIS_DIR;
  if (customNsisDir) {
    const candidate = path.join(customNsisDir, 'Bin', 'makensis.exe');
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default: electron-builder downloads NSIS to LOCALAPPDATA\electron-builder\Cache\nsis\nsis-<ver>\Bin\makensis.exe
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not defined; cannot locate NSIS (makensis.exe).');
  }

  const nsisCacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'nsis');
  if (!fsSync.existsSync(nsisCacheRoot)) {
    throw new Error(`NSIS cache not found at: ${nsisCacheRoot}`);
  }

  const entries = fsSync.readdirSync(nsisCacheRoot, { withFileTypes: true });
  const nsisDirs = entries
    .filter((e) => e.isDirectory() && /^nsis-/.test(e.name))
    .map((e) => e.name)
    .sort();

  for (let i = nsisDirs.length - 1; i >= 0; i--) {
    const dirName = nsisDirs[i];
    const candidate = path.join(nsisCacheRoot, dirName, 'Bin', 'makensis.exe');
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find makensis.exe under: ${nsisCacheRoot}`);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Skipping portable Windows installer build: not on win32.');
    return;
  }

  const projectRoot = path.join(__dirname, '..');
  const electronBuilder = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
  );
  const distDir = path.join(projectRoot, 'dist');
  const portableOutDir = path.join(distDir, 'portable');
  await fs.mkdir(portableOutDir, { recursive: true });

  const rawElectronVersion = require('../package.json').devDependencies['electron'];
  const electronVersion = semver.clean(String(rawElectronVersion).replace(/^\^/, ''));
  if (!electronVersion) {
    throw new Error(`Electron semver validation failed for version: '${rawElectronVersion}'.`);
  }

  const version = await getVersion();
  const cliVersion = require('../../arduino-ide-extension/package.json').arduino['arduino-cli'].version;

  // 1) Build an unpacked app directory (dir target) for Windows
  // We isolate it under dist/portable to avoid clobbering the normal build outputs.
  let unpackedDir =
    findFirstDirectory(portableOutDir, (name) => name.endsWith('-unpacked')) ||
    findFirstDirectory(portableOutDir, (name) => name.toLowerCase().includes('unpacked'));

  const onlyNsis = process.env.PORTABLE_ONLY_NSIS === 'true';

  if (!unpackedDir && !onlyNsis) {
    console.log('Building win dir (unpacked) payload for portable installer...');
    await exec(
      electronBuilder,
      [
        '--publish',
        'never',
        '--win',
        '--dir',
        '-c.electronVersion',
        electronVersion,
        '-c.extraMetadata.version',
        version,
        '-c.extraMetadata.name',
        'arduino-ide',
        '-c.extraMetadata.theia.frontend.config.appVersion',
        version,
        '-c.extraMetadata.theia.frontend.config.cliVersion',
        typeof cliVersion === 'string' ? cliVersion : '',
        '-c.extraMetadata.theia.frontend.config.buildDate',
        new Date().toISOString(),
        '-c.extraMetadata.main',
        './arduino-ide-electron-main.js',
        '-c.directories.output',
        portableOutDir,
        '-c.win.target',
        'dir',
      ],
      { stdio: 'inherit', cwd: projectRoot }
    );

    unpackedDir =
      findFirstDirectory(portableOutDir, (name) => name.endsWith('-unpacked')) ||
      findFirstDirectory(portableOutDir, (name) => name.toLowerCase().includes('unpacked'));
  }

  if (!unpackedDir) {
    throw new Error(`Could not find unpacked output under: ${portableOutDir}`);
  }

  // 2) Compile a tiny NSIS "portable installer" that extracts into:
  // <chosen>\\Arduino-IDE-AI-Assistant\\application + sibling folders.
  console.log('Compiling portable installer EXE (NSIS)...');
  const makensis = findMakensisExe();

  const outExe = path.join(
    distDir,
    `Arduino-IDE-AI-Assistant_${version}_Windows_64bit_portable.exe`
  );
  const nsiTemplate = path.join(projectRoot, 'resources', 'portable-installer.nsi');

  // NSIS treats some backslash sequences (e.g. "\v") as escapes.
  // Escape all backslashes in paths passed via defines.
  const nsisOutExe = outExe.replace(/\\/g, '\\\\');
  // NSIS has trouble reading very long source paths on Windows.
  // Copy the unpacked app to a short staging directory before compiling.
  const tempRoot = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  const stagingDir = path.join(tempRoot, 'ai-assistant-portable-unpacked');
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.cp(unpackedDir, stagingDir, { recursive: true });

  const nsisUnpackedDir = stagingDir.replace(/\\/g, '\\\\');

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outExe), { recursive: true });

  await exec(
    makensis,
    [
      '-V2',
      `-DOUTPUT_EXE=${nsisOutExe}`,
      `-DAPP_UNPACKED_DIR=${nsisUnpackedDir}`,
      nsiTemplate,
    ],
    {
      stdio: 'inherit',
      cwd: projectRoot,
      env: {
        ...process.env,
      },
    }
  );

  // Cleanup staging (best-effort).
  await fs.rm(stagingDir, { recursive: true, force: true });

  if (!fsSync.existsSync(outExe)) {
    throw new Error(
      `NSIS portable installer did not produce output EXE at: ${outExe}`
    );
  }

  console.log(`Portable installer created: ${outExe}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
