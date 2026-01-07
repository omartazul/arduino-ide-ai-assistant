// @ts-check
'use strict';

const os = require('os');
const path = require('path');
const { app } = require('electron');

function tryGetPortableRootFromExecPath() {
  try {
    const exePath = process.execPath;
    const applicationDir = path.dirname(exePath);
    if (path.basename(applicationDir).toLowerCase() !== 'application') {
      return undefined;
    }
    return path.dirname(applicationDir);
  } catch {
    return undefined;
  }
}

// IMPORTANT: configure portable paths before loading Theia/Electron backend.
// Otherwise Electron will initialize default `userData` under %APPDATA%\arduino-ide.
const portableRoot = tryGetPortableRootFromExecPath();
if (portableRoot) {
  const portableConfigDir = path.join(portableRoot, 'Configuration');
  process.env.ARDUINO_IDE_AI_PORTABLE_ROOT = portableRoot;

  // Force both Chromium + Electron to use the portable config location.
  // This is the most reliable way to prevent `%APPDATA%\\arduino-ide` from being used.
  app.commandLine.appendSwitch('user-data-dir', portableConfigDir);
  app.setPath('appData', portableConfigDir);
  app.setPath('userData', portableConfigDir);
  app.setPath('crashDumps', portableConfigDir);

  if (process.platform === 'win32') {
    process.env.APPDATA = portableConfigDir;
  }

  // Keep manually installed plugins in the portable area too.
  // (Bundled plugins remain under the app folder via THEIA_DEFAULT_PLUGINS.)
  process.env.THEIA_PLUGINS = [
    process.env.THEIA_PLUGINS,
    `local-dir:${path.resolve(portableConfigDir, 'plugins')}`,
  ]
    .filter(Boolean)
    .join(',');
}

const config = require('./package.json').theia.frontend.config;
// `buildDate` is only available in the bundled application.
if (config.buildDate) {
  // `plugins` folder inside IDE2. IDE2 is shipped with these VS Code extensions. Such as cortex-debug, vscode-cpp, and translations.
  process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${path.resolve(
    __dirname,
    'plugins'
  )}`;
  // `plugins` folder inside the `~/.arduinoIDE` folder. This is for manually installed VS Code extensions. For example, custom themes.
  // In portable mode, THEIA_PLUGINS was already redirected to the portable Configuration folder above.
  if (!portableRoot) {
    process.env.THEIA_PLUGINS = [
      process.env.THEIA_PLUGINS,
      `local-dir:${path.resolve(os.homedir(), '.arduinoIDE', 'plugins')}`,
    ]
      .filter(Boolean)
      .join(',');
  }
}

require('./lib/backend/electron-main');
