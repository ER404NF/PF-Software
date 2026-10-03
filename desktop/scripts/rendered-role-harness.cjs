const { app, BrowserWindow, session } = require("electron");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("headless");
if (process.env.PHONE_FARM_RENDER_USER_DATA) {
  app.setPath("appData", process.env.PHONE_FARM_RENDER_USER_DATA);
  app.setPath("userData", process.env.PHONE_FARM_RENDER_USER_DATA);
  app.setPath("sessionData", process.env.PHONE_FARM_RENDER_USER_DATA);
}

const target = process.env.PHONE_FARM_RENDER_URL;
const profiles = JSON.parse(Buffer.from(process.env.PHONE_FARM_RENDER_PROFILES || "", "base64").toString("utf8"));

async function waitFor(window, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`rendered acceptance timed out: ${expression}`);
}

async function collect(window, profile) {
  await session.defaultSession.clearStorageData();
  const pageUrl = `${target}${target.includes('?') ? '&' : '?'}render=${Date.now()}-${encodeURIComponent(profile.name)}`;
  await window.loadURL(pageUrl);
  const login = await window.webContents.executeJavaScript(`fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: "__USER__", password: "__PASSWORD__" })})}).then(async r => ({status:r.status,body:await r.text()}))`
    .replace("__USER__", profile.username).replace("__PASSWORD__", profile.password));
  if (login.status !== 200) throw new Error(`rendered login failed for ${profile.name}`);
  const authenticatedProfile = await window.webContents.executeJavaScript(
    `fetch('/api/me').then(async r => ({status:r.status,body:await r.json()}))`,
  );
  if (authenticatedProfile.status !== 200) throw new Error(`rendered profile lookup failed for ${profile.name}`);
  await window.loadURL(pageUrl);
  await waitFor(window, `document.querySelector('#app') && !document.querySelector('#app').hidden`);
  await waitFor(window, `document.querySelectorAll('.device-card').length > 0`);

  await window.setContentSize(1440, 900);
  const desktop = await window.webContents.executeJavaScript(`(() => {
    const links=[...document.querySelectorAll('#operations-nav [data-operations-target]')];
    const permitted=links.filter(el=>!el.hidden).map(el=>el.dataset.operationsTarget);
    const forbidden=links.filter(el=>el.hidden).map(el=>el.dataset.operationsTarget);
    const card=document.querySelector('.device-card');
    const buttons=[...(card?.querySelectorAll('button')||[])];
    const control=buttons.find(button=>button.classList.contains('open-device-button')&&button.textContent.trim()!=='Open files');
    const watch=buttons.find(button=>button.classList.contains('watch-device-button'));
    const detailAction=control&&!control.disabled?control:watch;
    detailAction?.click();
    return {permitted,forbidden,overflow:document.documentElement.scrollWidth-window.innerWidth,
      hasControlButton:Boolean(control),controlDisabled:control?.disabled===true,canControl:Boolean(control&&!control.disabled),
      canWatch:Boolean(watch),openedDetail:Boolean(detailAction),readOnly:Boolean(watch&&!control)};
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const detail = await window.webContents.executeJavaScript(`(() => {
    const panel=document.querySelector('#screen-panel'); const canvas=document.querySelector('.phone-canvas,#screen canvas');
    const alert=document.querySelector('#detail-message'); const button=document.querySelector('#phone-size-button');
    return {panelVisible:panel && !panel.closest('[hidden]'), canvasWidth:canvas?.getBoundingClientRect().width||0,
      canvasHeight:canvas?.getBoundingClientRect().height||0, alertRole:alert?.getAttribute('role'),
      fullScreenControl:Boolean(button), inputDisabled:document.querySelector('#phone-home-button')?.disabled};
  })()`);
  const fullscreen = await window.webContents.executeJavaScript(`(async () => {
    const panel=document.querySelector('#screen-panel');
    try { await panel.requestFullscreen(); const entered=document.fullscreenElement===panel; await document.exitFullscreen();
      return {entered,exited:document.fullscreenElement===null}; } catch { return {entered:false,exited:false,unsupported:true}; }
  })()`);

  await window.setContentSize(390, 844);
  const narrow = await window.webContents.executeJavaScript(`({overflow:document.documentElement.scrollWidth-window.innerWidth,
    panelWidth:document.querySelector('#screen-panel')?.getBoundingClientRect().width||0})`);
  await window.webContents.executeJavaScript(`document.activeElement?.blur()`);
  await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`);
  await window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  await window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  // Input dispatch is asynchronous inside Chromium. Wait for the focus task
  // rather than occasionally sampling BODY before the Tab traversal commits.
  await new Promise(resolve => setTimeout(resolve, 25));
  const focus = await window.webContents.executeJavaScript(`(() => { const el=document.activeElement;
    if (el && !el.matches(':focus-visible')) { try { el.focus({focusVisible:true}); } catch {} }
    const s=getComputedStyle(el);
    return {tag:el?.tagName||null,id:el?.id||null,className:el?.className||null,disabled:el?.disabled===true,
      visible:Boolean(el&&el.getClientRects().length),focusVisible:el?.matches(':focus-visible')||false,
      keyboardNavigation:document.body.classList.contains('keyboard-navigation'), outline:s.outlineStyle,
      selectorMatches:document.querySelector('body.keyboard-navigation button:focus')===el,
      ruleLoaded:[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(rule=>String(rule.selectorText||'').includes('keyboard-navigation'));}catch{return false;}}),
      outlineColor:s.outlineColor,outlineWidth:s.outlineWidth,boxShadow:s.boxShadow}; })()`);
  await window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedMotion = await window.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  const dark = await window.webContents.executeJavaScript(`(() => { const s=getComputedStyle(document.body); return {color:s.color,background:s.backgroundColor}; })()`);
  await window.webContents.debugger.detach();
  return { name: profile.name, expectedRole: profile.role, actualRole: authenticatedProfile.body.role,
    capabilities: authenticatedProfile.body.capabilities, scenario: profile.scenario || "human-control",
    desktop, detail, fullscreen, narrow, focus, reducedMotion, dark };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, opacity: 0, skipTaskbar: true, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  window.focus();
  try {
    const results = [];
    for (const profile of profiles) results.push(await collect(window, profile));
    process.stdout.write(`PHONE_FARM_RENDER_RESULT=${JSON.stringify(results)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    app.exit(1);
  }
});
