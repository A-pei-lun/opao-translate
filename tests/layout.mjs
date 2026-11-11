import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createProfile, normalizeSettings } from '../src/shared/config.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.dirname(source);
const current = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')).version;
const version = process.argv[2] || current;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid layout test version');
const extension = path.join(project, '05_构建产物', 'O泡翻译-' + version);
const evidence = path.join(project, '04_验证', current,
  '布局回归', version === current ? version : '基线-' + version);
const profile = path.join(evidence, '测试配置');
await fs.mkdir(evidence, { recursive: true });
try {
  if ((await fs.lstat(profile)).isSymbolicLink() ||
      (await fs.readFile(path.join(profile, 'TASK_OWNED'), 'utf8')) !== 'opao-layout-tests')
    throw new Error('Layout test profile ownership mismatch');
  if (!profile.startsWith(path.resolve(project, '04_验证') + path.sep))
    throw new Error('Layout test profile outside validation root');
  await fs.rm(profile, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.mkdir(profile, { recursive: true });
await fs.writeFile(path.join(profile, 'TASK_OWNED'), 'opao-layout-tests');

const icon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" d="M4 5h16v14H4zM8 9h8M8 13h5"/></svg>';
const sidebar = `<!doctype html><html lang="en"><head><title>Sidebar layout fixture</title><style>
*{box-sizing:border-box}body{margin:0;background:#30302e;color:#eee;font:14px/1.5 Arial}
aside{width:264px;height:100vh;position:fixed;display:flex;flex-direction:column;background:#292928;padding:12px}
header{padding:8px;font-weight:bold}.scroll{flex:1;min-height:0;overflow-y:auto}ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.row,.group-label{display:flex;align-items:center;gap:8px;height:36px;padding:8px;width:100%;color:inherit;text-decoration:none;white-space:nowrap;border-radius:6px;flex-shrink:1}
button.row{font:inherit;text-align:left;border:0;background:transparent;cursor:pointer}.row:hover,.row.active{background:#41413e}
.row svg{width:16px;height:16px;flex-shrink:0}.row .label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.group-label{height:32px;color:#aaa;font-size:12px;margin-top:12px}.clipped{max-height:36px;overflow:hidden}
.grid-row{display:grid;grid-template-columns:16px 1fr}.nested-label{display:block}.nested-label strong{font-weight:normal}
.footer{flex-shrink:0;border-top:1px solid #555;padding-top:8px}.account{display:flex;gap:8px;height:44px;align-items:center}
main{margin-left:300px;padding:24px}main p{max-width:700px}.badge{margin-left:auto;font-size:11px}
</style></head><body><aside id="sidebar"><header>GLaDOS</header><div id="nav-scroll" class="scroll"><nav>
<div class="group-label" id="group-connect">Connect</div><ul id="links">
<li><a id="setup" class="row" href="#setup">${icon}Setup</a></li>
<li><a id="subscription" class="row active" href="#subscription">${icon}<span class="label">Subscription</span></a></li>
<li><a id="rules" class="row clipped" href="#rules">${icon}<span class="label">Rules Editor</span></a></li>
<li><a id="claude" class="row" href="#claude">${icon}<div class="nested-label"><strong>Claude, Codex &amp; More</strong></div></a></li>
<li><button id="security" class="row" onclick="window.clicks=(window.clicks||0)+1">${icon}Security</button></li>
<li><a id="limits" class="row grid-row" href="#limits">${icon}<span>Rate Limits</span></a></li>
</ul><div class="group-label" id="group-platform">Platform</div><ul>
${['Shop','Usage','Membership','Giftcard Code','Claim Code','Points','Invite Plan'].map((text, i) => `<li><a id="platform-${i}" class="row" href="#p-${i}">${icon}${text}${i === 2 ? '<span class="badge">13d</span>' : ''}</a></li>`).join('')}
</ul></nav></div><div class="footer"><div id="account" class="account">Fixture account</div></div></aside>
<main><h1>Subscriptions</h1><p>View and copy your subscription URLs for different clients.</p>
<p id="main-copy">A normal article paragraph keeps its configured paragraph spacing.</p></main></body></html>`;
const steamCases = {
  leading: '<div id="description"><br>ADDON STILL WORK IN PROGRESS</div>',
  trailing: '<div id="description">A workshop description ends with a line break.<br></div>',
  isolated: '<p><br></p><p id="description">A paragraph after an empty line.</p>',
  comments: '<div id="description"><br><!-- layout marker -->Rules<br> <!-- boundary --> <br>No reupload<br></div>',
  workshop: '<div id="description" class="workshopItemDescription"><br><h2>ADDON STILL WORK IN PROGRESS</h2><br><div class="bb_h2">Rules</div><ul><li>No SFM ports</li><li>No reupload</li></ul><br><br><div class="bb_h2">News, bug reports and suggestions</div>The discord server was made for activity, bug reports and suggestions.<br><a href="#discord" id="discord">Discord</a><br><br><div class="bb_h2">Credits</div><ul><li><b>Doors by LSPLASH</b> | Assets belong to them</li></ul><br></div>',
};
function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
}
let requests = 0;
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }
  if (req.url === '/sidebar' || req.url === '/sidebar-data') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/sidebar' ? sidebar : sidebar
      .replace('aside{', '[data-sidebar="sidebar"]{')
      .replace('<aside id="sidebar">', '<div id="sidebar" data-sidebar="sidebar">')
      .replace('</aside>', '</div>')
      .replace('id="nav-scroll"', 'id="nav-scroll" data-sidebar="content"')
      .replace('<nav>', '<div data-sidebar="group">').replace('</nav>', '</div>')
      .replace('<ul id="links">', '<ul id="links" data-sidebar="menu">')
      .replaceAll('class="row', 'data-sidebar="menu-button" class="row'));
    return;
  }
  if (req.url.startsWith('/steam/')) {
    const content = steamCases[req.url.split('/').at(-1)] || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><title>Workshop fixture</title><style>body{font:16px/1.6 Arial;background:#273647;color:#ddd;margin:40px auto;max-width:900px}h2,.bb_h2{color:#64bcec;font-size:20px}a{color:#ddd}#description{max-width:650px}</style></head><body><main>${content}<p id="after">Another paragraph must still be detected.</p></main></body></html>`);
    return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const prompt = body.messages.at(-1).content;
  const parsed = JSON.parse(prompt);
  requests++;
  const labels = { Setup:'设置', Subscription:'订阅', 'Rules Editor':'规则编辑器',
    'Claude, Codex & More':'Claude、Codex 及更多', Security:'安全', 'Rate Limits':'速率限制',
    Platform:'平台', Connect:'连接', Shop:'商店', Usage:'用量', Membership:'会员',
    'Giftcard Code':'礼品卡代码', 'Claim Code':'领取代码', Points:'积分', 'Invite Plan':'邀请计划' };
  const output = JSON.stringify({ translations: parsed.items.map(({ id, text }) => ({
    id, text: Object.entries(labels).reduce((value, [original, translated]) =>
      value.replaceAll(original, translated), '译文 ' + text),
  })) });
  json(res, { choices: [{ message: { content: output } }] });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const checks = [], errors = [], metrics = {};
let context;
async function check(name, run) {
  try {
    await run();
    checks.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
    console.log('FAIL ' + name + ' ' + error.message.slice(0, 240));
  }
}
async function rpc(page, kind, fields = {}) {
  const result = await page.evaluate(({ kind, fields }) =>
    chrome.runtime.sendMessage({ channel:'opao', kind, ...fields }), { kind, fields });
  if (!result?.ok) throw new Error(result?.error || 'RPC failed');
  return result.data;
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, viewport: { width: 1280, height: 960 },
    args: ['--load-extension=' + extension, '--disable-extensions-except=' + extension,
      '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  context.setDefaultTimeout(5000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), version);
  const settings = await context.newPage();
  const workerUrl = new URL(worker.url());
  await settings.goto(workerUrl.protocol + '//' + workerUrl.host + '/settings.html');
  const config = normalizeSettings({ profiles: [{ ...createProfile('layout'),
    baseUrl:base + '/v1', model:'layout-fixture', apiKey:'', retries:0 }],
    roles:{ text:'layout' }, lazy:false, translateTitle:false, cache:false });
  await rpc(settings, 'save-settings', { settings:config });
  async function action(page, action) {
    await page.bringToFront();
    const result = await rpc(settings, 'tab-action', { action });
    if (result?.ok === false) throw new Error(result.error);
  }
  for (const name of Object.keys(steamCases)) {
    const page = await context.newPage();
    await page.goto(base + '/steam/' + name);
    await page.locator('opao-reader-ui').waitFor();
    const original = await page.locator('main').innerHTML();
    await check('Steam break handling: ' + name, async () => {
      await action(page, 'toggle-page');
      await page.locator('#description .opao-target[data-state=done]').first().waitFor();
      await page.locator('#after .opao-target[data-state=done]').waitFor();
      assert.equal(await page.locator('.opao-target[data-state=error]').count(), 0);
      assert.equal(await page.locator('.opao-target .opao-target').count(), 0);
      if (name === 'workshop') {
        for (const heading of await page.locator('#description h2,#description .bb_h2').all())
          await heading.locator('.opao-target[data-state=done]').waitFor();
        for (const item of await page.locator('#description li').all())
          await item.locator('.opao-target[data-state=done]').waitFor();
        await page.locator('#description .opao-target[data-state=done] a[href="#discord"]').waitFor();
        assert.equal(await page.locator('#discord').getAttribute('href'), '#discord');
        await page.screenshot({ path:path.join(evidence, 'Steam段落翻译.png'), fullPage:true, caret:'initial' });
      }
    });
    await action(page, 'restore');
    assert.equal(await page.locator('main').innerHTML(), original);
    await page.close();
  }
  const page = await context.newPage();
  await page.goto(base + '/sidebar');
  await page.locator('opao-reader-ui').waitFor();
  const original = await page.locator('#sidebar').innerHTML();
  const sidebarStyle = await page.locator('#sidebar').getAttribute('style');
  await action(page, 'toggle-page');
  for (const id of ['setup','subscription','rules','claude','security','limits','platform-6'])
    await page.locator('#' + id + ' .opao-target[data-state=done]').waitFor();
  async function geometry() {
    return page.locator('#sidebar').evaluate((sidebar) => {
      const rows = [...sidebar.querySelectorAll('.row,.group-label')].map((row) => {
        const box = row.getBoundingClientRect();
        const targets = [...row.querySelectorAll('.opao-target')].map((target) => {
          const rect = target.getBoundingClientRect();
          return { top:rect.top, bottom:rect.bottom, left:rect.left, right:rect.right };
        });
        return { id:row.id, top:box.top, bottom:box.bottom, left:box.left, right:box.right, targets };
      });
      const scroll = sidebar.querySelector('#nav-scroll');
      return { rows, sidebarHeight:sidebar.getBoundingClientRect().height,
        scrollOverflow:getComputedStyle(scroll).overflowY, scrollHeight:scroll.scrollHeight,
        scrollClient:scroll.clientHeight };
    });
  }
  function assertGeometry(result) {
    for (const row of result.rows) {
      assert.ok(row.targets.length, 'No translation for ' + row.id);
      for (const target of row.targets) {
        assert.ok(target.top >= row.top - 1 && target.bottom <= row.bottom + 1,
          'Translation outside its row: ' + JSON.stringify(row));
        assert.ok(target.left >= row.left - 1 && target.right <= row.right + 1,
          'Translation overflows horizontally: ' + JSON.stringify(row));
      }
    }
    for (let i = 1; i < result.rows.length; i++)
      assert.ok(result.rows[i].top >= result.rows[i - 1].bottom - 1,
        'Overlapping rows: ' + result.rows[i - 1].id + ' and ' + result.rows[i].id);
    assert.equal(result.scrollOverflow, 'auto');
    assert.equal(result.sidebarHeight, 960);
  }
  await check('Fixed navigation rows contain translations without overlapping', async () => {
    metrics.bilingual = await geometry();
    await page.screenshot({ path:path.join(evidence, '侧栏双语排版.png'), fullPage:true, caret:'initial' });
    assertGeometry(metrics.bilingual);
  });
  await check('Navigation button keeps its click handler', async () => {
    await page.locator('#security').click();
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await check('Translation-only and bilingual toggles keep rows contained', async () => {
    await action(page, 'only-translation');
    try {
      metrics.translationOnly = await geometry();
      assertGeometry(metrics.translationOnly);
    } finally {
      await action(page, 'only-translation');
    }
    metrics.toggledBack = await geometry();
    assertGeometry(metrics.toggledBack);
  });
  await check('Larger typography reflows navigation and preserves article spacing', async () => {
    await rpc(settings, 'patch-settings', { patch:{ textSize:140,
      translationLineHeight:2, translationParagraphGap:1, translationStyle:'soft' } });
    await page.waitForFunction(() => document.querySelector('#setup .opao-target')?.style.fontSize === '140%');
    metrics.largerText = await geometry();
    assertGeometry(metrics.largerText);
    const iconAlignment = await page.locator('#claude').evaluate((row) => ({
      iconTop:row.querySelector('svg').getBoundingClientRect().top,
      textTop:row.querySelector('strong').getBoundingClientRect().top,
    }));
    assert.ok(Math.abs(iconAlignment.iconTop - iconAlignment.textTop) <= 8,
      'Icon separated from its original label: ' + JSON.stringify(iconAlignment));
    const article = await page.locator('#main-copy .opao-target').evaluate((target) => ({
      margin:parseFloat(getComputedStyle(target).marginTop), font:parseFloat(getComputedStyle(target).fontSize),
    }));
    assert.ok(article.margin >= article.font - 1);
    await page.screenshot({ path:path.join(evidence, '侧栏大字号.png'), fullPage:true, caret:'initial' });
  });
  await check('Expanded sidebar retains scrolling and exposes the final translation', async () => {
    await page.locator('#nav-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const visible = await page.locator('#nav-scroll').evaluate((node) => {
      const viewport = node.getBoundingClientRect();
      const target = node.querySelector('#platform-6 .opao-target').getBoundingClientRect();
      return { top:viewport.top, bottom:viewport.bottom, targetTop:target.top, targetBottom:target.bottom };
    });
    assert.ok(visible.targetTop >= visible.top - 1 && visible.targetBottom <= visible.bottom + 1,
      JSON.stringify(visible));
  });
  await check('Navigation restores exact original DOM and inline styles', async () => {
    await action(page, 'restore');
    assert.equal(await page.locator('#sidebar').innerHTML(), original);
    assert.equal(await page.locator('#sidebar').getAttribute('style'), sidebarStyle);
    assert.equal(await page.locator('.opao-target').count(), 0);
  });
  await page.close();
  await rpc(settings, 'save-settings', { settings:config });
  const dataPage = await context.newPage();
  await dataPage.goto(base + '/sidebar-data');
  await dataPage.locator('opao-reader-ui').waitFor();
  await dataPage.evaluate(() => {
    const row = document.getElementById('setup');
    row.style.setProperty('height', '36px', 'important');
    row.style.setProperty('white-space', 'nowrap');
    row.style.setProperty('--site-color', 'cadetblue');
    window.originalButton = document.getElementById('security');
  });
  await action(dataPage, 'toggle-page');
  await dataPage.locator('#setup .opao-target[data-state=done]').waitFor();
  await check('Data-attribute sidebar rows and dynamic items grow naturally', async () => {
    await dataPage.locator('#links').evaluate((list) => {
      const item = document.createElement('li');
      item.innerHTML = '<a id="late-nav" data-sidebar="menu-button" class="row" href="#late">A newly opened sidebar item</a>';
      list.append(item);
    });
    await dataPage.locator('#late-nav .opao-target[data-state=done]').waitFor();
    for (const id of ['setup','late-nav']) {
      const size = await dataPage.locator('#' + id).evaluate((row) => ({
        bottom:row.getBoundingClientRect().bottom,
        targetBottom:row.querySelector('.opao-target').getBoundingClientRect().bottom,
      }));
      assert.ok(size.targetBottom <= size.bottom + 1, JSON.stringify(size));
    }
    assert.equal(await dataPage.locator('#sidebar').evaluate((node) => node.clientHeight), 960);
    assert.equal(await dataPage.locator('#nav-scroll').evaluate((node) => getComputedStyle(node).overflowY), 'auto');
  });
  await check('Restore preserves inline priorities and subsequent website style changes', async () => {
    await dataPage.locator('#rules').evaluate((row) => {
      row.style.setProperty('height', '73px', 'important');
      row.style.setProperty('color', 'rgb(80, 150, 200)');
    });
    await action(dataPage, 'restore');
    const styles = await dataPage.evaluate(() => {
      const original = document.getElementById('setup').style;
      const changed = document.getElementById('rules').style;
      return { height:original.height, priority:original.getPropertyPriority('height'),
        whitespace:original.whiteSpace, custom:original.getPropertyValue('--site-color'),
        changedHeight:changed.height, changedPriority:changed.getPropertyPriority('height'),
        changedColor:changed.color, sameButton:document.getElementById('security') === window.originalButton };
    });
    assert.deepEqual(styles, { height:'36px', priority:'important', whitespace:'nowrap', custom:'cadetblue',
      changedHeight:'73px', changedPriority:'important', changedColor:'rgb(80, 150, 200)', sameButton:true });
    assert.equal(await dataPage.locator('.opao-target').count(), 0);
  });
} catch (error) {
  checks.push({ name:'initialization or teardown', status:'FAIL', error:error.stack });
  console.log(error.stack);
} finally {
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const report = { version, date:new Date().toISOString(), mode:'Isolated Edge extension with local mock API',
    checks, metrics, browserErrors:errors, apiRequests:requests,
    untested:['Original authenticated GLaDOS page', 'Original Steam workshop URL', 'Real model output'] };
  await fs.writeFile(path.join(evidence, '布局验证结果.json'), JSON.stringify(report, null, 2));
  const passed = checks.filter((item) => item.status === 'PASS').length;
  const failed = checks.length - passed;
  console.log(JSON.stringify({ version, passed, failed, errors:errors.length, evidence }, null, 2));
  if (failed || errors.length || !checks.length) process.exitCode = 1;
}
