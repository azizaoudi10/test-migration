// electron-builder afterPack hook.
//
// The AppImage target writes its own AppRun into the staging AppDir, then
// copies the packed app dir over the staging dir (app-builder-lib
// appImageUtil.js: writeAppLauncherAndRelatedFiles() before copyDir(appDir,
// stageDir)). A curated AppRun placed in appOutDir therefore wins.
//
// The curated script adds GTK module sanitization (Electron 36 dlopens both
// GTK3 and GTK4; injected GTK3 modules abort the GTK4 load) and keeps the
// unshare-based sandbox probe. See scripts/appimage-AppRun.
const { copyFile, chmod } = require('node:fs/promises');
const { join } = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    const source = join(context.packager.projectDir, 'scripts', 'appimage-AppRun');
    const target = join(context.appOutDir, 'AppRun');
    await copyFile(source, target);
    await chmod(target, 0o755);
  }
};
