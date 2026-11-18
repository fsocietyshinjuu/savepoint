'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const outDir = path.join(__dirname, '..', 'landing', 'assets');
const url = process.env.LANDING_URL || 'http://localhost:4173';

// Fresh profile each run so the persisted landing theme never leaks between captures.
app.setPath('userData', path.join(os.tmpdir(), `savepoint-landing-shot-${process.pid}`));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setTheme = (theme) => `
  document.documentElement.dataset.theme = '${theme}';
  document.querySelectorAll('[data-shot]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.shot === '${theme}');
  });
  document.querySelectorAll('[data-shot-img]').forEach((image) => {
    image.classList.toggle('is-active', image.dataset.shotImg === '${theme}');
  });
  document.documentElement.style.scrollBehavior = 'auto';
  window.scrollTo(0, 0);
  'ok'
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    backgroundColor: '#080a07',
    webPreferences: { offscreen: false },
  });

  await win.loadURL(url);
  await wait(1800);

  await win.webContents.executeJavaScript(setTheme('dark'));
  await wait(900);
  fs.writeFileSync(
    path.join(outDir, 'preview-desktop-dark.png'),
    (await win.webContents.capturePage()).toPNG(),
  );

  await win.webContents.executeJavaScript(setTheme('light'));
  await wait(900);
  fs.writeFileSync(
    path.join(outDir, 'preview-desktop-light.png'),
    (await win.webContents.capturePage()).toPNG(),
  );

  const height = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  const [width] = win.getContentSize();
  win.setContentSize(width, Math.min(height, 6000));
  await wait(800);
  await win.webContents.executeJavaScript(setTheme('dark'));
  await wait(600);
  fs.writeFileSync(
    path.join(outDir, 'preview-full-dark.png'),
    (await win.webContents.capturePage()).toPNG(),
  );

  console.log('landing previews written', width, height);
  app.quit();
});
