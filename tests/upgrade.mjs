import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.dirname(source);
const version = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')).version;
const fromVersion = '0.1.1';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid upgrade version');
const evidence = path.resolve(project, '04_验证', version);
const profile = path.join(evidence, '升级测试配置');
if (!profile.startsWith(path.resolve(project, '04_验证') + path.sep))
  throw new Error('Upgrade profile outside validation root');
await fs.mkdir(evidence, { recursive: true });
try {
  if (
    (await fs.lstat(profile)).isSymbolicLink() ||
    (await fs.readFile(path.join(profile, 'TASK_OWNED'), 'utf8')) !== 'opao-upgrade-test'
  )
    throw new Error('Upgrade profile ownership mismatch');
  await fs.rm(profile, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(path.join(profile, 'TASK_OWNED'), 'opao-upgrade-test');
async function launch(folder) {
  return chromium.launchPersistentContext(profile, {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: [
      '--load-extension=' + folder,
      '--disable-extensions-except=' + folder,
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
}
async function workerFor(context, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const worker of context.serviceWorkers()) {
      try {
        if ((await worker.evaluate(() => chrome.runtime.getManifest().version)) === expected)
          return worker;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Expected extension version did not load: ' + expected);
}
async function rpc(page, kind, fields = {}) {
  const response = await page.evaluate(
    ({ kind, fields }) => chrome.runtime.sendMessage({ channel: 'opao', kind, ...fields }),
    { kind, fields },
  );
  if (!response?.ok) throw new Error(response?.error || 'Upgrade RPC failed');
  return response.data;
}
let context;
const result = { from: fromVersion, to: version, status: 'FAIL' };
try {
  context = await launch(path.join(project, '05_构建产物', 'O泡翻译-' + fromVersion));
  const oldWorker = await workerFor(context, fromVersion);
  const oldId = new URL(oldWorker.url()).host;
  const page = await context.newPage();
  await page.goto('chrome-extension://' + oldId + '/settings.html');
  await page.getByRole('button', { name: '保存设置', exact: true }).waitFor();
  await rpc(page, 'save-settings', {
    settings: {
      profiles: [
        {
          id: 'legacy',
          name: '我的旧中转站',
          protocol: 'chat',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'upgrade-model',
          apiKey: 'upgrade-fixture-key',
          capabilities: { text: true, vision: false, asr: false },
        },
      ],
      roles: { text: 'legacy' },
      translationStyle: 'soft',
      textSize: 118,
    },
  });
  await context.close();
  context = undefined;
  context = await launch(path.join(project, '05_构建产物', 'O泡翻译-' + version));
  const worker = await workerFor(context, version);
  const reloadedWorker = context.waitForEvent('serviceworker', { timeout: 15000 });
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await reloadedWorker;
  const currentWorker = await workerFor(context, version);
  const newId = new URL(currentWorker.url()).host;
  assert.equal(newId, oldId);
  const upgraded = await context.newPage();
  await upgraded.goto('chrome-extension://' + newId + '/settings.html');
  await upgraded.getByRole('button', { name: '保存设置', exact: true }).waitFor();
  const settings = await rpc(upgraded, 'get-settings');
  assert.equal(settings.roles.text, 'legacy');
  assert.equal(settings.profiles[0].apiKey, 'upgrade-fixture-key');
  assert.equal(settings.profiles[0].model, 'upgrade-model');
  assert.equal(settings.profiles[0].name, '我的旧中转站');
  assert.equal(settings.serviceFallback.enabled, false);
  assert.deepEqual(settings.serviceFallback.order, ['legacy']);
  assert.equal(settings.translationStyle, 'soft');
  assert.equal(settings.textSize, 118);
  assert.equal(settings.translationFont, '');
  assert.equal(settings.translationLineHeight, 1.8);
  Object.assign(result, {
    status: 'PASS',
    extensionId: newId,
    profileRetained: true,
    keyRetained: true,
    explicitStyleRetained: true,
    newAppearanceDefaults: true,
    customNameRetained: true,
    fallbackDefaultDisabled: true,
    fallbackOrderMigrated: true,
    explicitExtensionReload: true,
  });
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await fs.writeFile(path.join(evidence, '升级验证结果.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
