(() => {
  const P = window.FollowerLensParse;
  const SETTINGS_KEY = "fl_settings";
  const HIST_KEY = "fl_hist";
  const CTX_KEY = "fl_ctx";
  const HIST_MAX_USERS = 3000;
  const HIST_MAX_POINTS = 40;
  const HIST_MIN_GAP = 6 * 3600e3;
  const CTX_MAX = 800;          // 本地索引最多留多少条推文
  const CTX_TEXT_MAX = 400;     // 单条正文存多少字
  const CTX_SHOW_MAX = 160;     // 引用块里显示多少字
  const REQ_SOURCE = "follower-lens-req";
  const RES_SOURCE = "follower-lens-res";
  const FETCH_TIMEOUT = 12000;

  const users = new Map();      // handle -> user
  const tweetSeen = new Set();  // 去重,避免同一条推文重复累计
  const stats = new Map();      // handle -> { views, interactions }
  let settings = null;          // 读完存储后才渲染
  let settingsVer = 0;
  let hist = {};
  let histDirty = false;
  let ctxIndex = new Map();     // 推文 id -> 上下文记录(用于还原"被回复的是哪条")
  let ctxDirty = false;
  const fetchState = new Map(); // 通知里那条推文 id -> "loading" | { error }
  const waiters = new Map();    // 补取请求序号 -> resolve
  let reqSeq = 0;
  let meUid = null;             // 本人 rest_id(接口里拿)
  let meHandleCache = null;     // 本人 @handle(页面里拿)
  let msgCount = 0;
  const pending = [];           // 设置读完之前收到的数据包

  // ---------- 设置与历史 ----------
  const storage = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) || null;

  function init() {
    if (!storage) { settings = P.mergeSettings(); flush(); return; }
    storage.get([SETTINGS_KEY, HIST_KEY, CTX_KEY], (res) => {
      settings = P.mergeSettings(res && res[SETTINGS_KEY]);
      hist = (res && res[HIST_KEY]) || {};
      ctxIndex = new Map(Object.entries((res && res[CTX_KEY]) || {}));
      applyDebug();
      flush();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[HIST_KEY] && changes[HIST_KEY].newValue === undefined) hist = {};  // 弹窗里清除了记录
      if (changes[CTX_KEY] && changes[CTX_KEY].newValue === undefined) ctxIndex = new Map();
      if (!changes[SETTINGS_KEY]) return;
      settings = P.mergeSettings(changes[SETTINGS_KEY].newValue);
      settingsVer++;
      applyDebug();
      scheduleRender();
    });
  }

  function flush() {
    while (pending.length) handleMessage(pending.shift());
    scheduleRender();
  }

  function recordHistory(u, now) {
    if (!settings.trackHistory) return;
    const arr = hist[u.handle] || (hist[u.handle] = []);
    const last = arr[arr.length - 1];
    if (last && now - last[0] < HIST_MIN_GAP) return;
    arr.push([now, u.followers]);
    if (arr.length > HIST_MAX_POINTS) arr.shift();
    histDirty = true;
  }

  function trimHist() {
    const handles = Object.keys(hist);
    if (handles.length <= HIST_MAX_USERS) return;
    handles
      .sort((a, b) => hist[a][hist[a].length - 1][0] - hist[b][hist[b].length - 1][0])
      .slice(0, handles.length - HIST_MAX_USERS)
      .forEach((h) => delete hist[h]);
  }

  function trimCtx() {
    if (ctxIndex.size <= CTX_MAX) return;
    // 优先丢最老的推文;时间取不到的当最新,尽量留着
    const ids = [...ctxIndex.keys()].sort(
      (a, b) => (ctxIndex.get(a).createdAt || Infinity) - (ctxIndex.get(b).createdAt || Infinity)
    );
    ids.slice(0, ids.length - CTX_MAX).forEach((id) => ctxIndex.delete(id));
  }

  let saveTimer = null;
  function scheduleSave() {
    if (!storage || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const patch = {};
      if (histDirty) { histDirty = false; trimHist(); patch[HIST_KEY] = hist; }
      if (ctxDirty) {
        ctxDirty = false;
        trimCtx();
        patch[CTX_KEY] = Object.fromEntries(ctxIndex);
      }
      if (!Object.keys(patch).length) return;
      try { storage.set(patch); } catch (_) {}
    }, 3000);
  }

  // ---------- 数据包处理 ----------
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    // 补取请求的回包
    if (e.data.source === RES_SOURCE) {
      const w = waiters.get(e.data.id);
      if (!w) return;
      waiters.delete(e.data.id);
      w(e.data);
      return;
    }
    if (e.data.source !== "follower-lens") return;
    msgCount++;
    if (!settings) { pending.push(e.data.body); return; }
    handleMessage(e.data.body);
    scheduleRender();
  });

  // 同一条推文可能来自多个响应,正文更全的那份留下
  function mergeCtx(list) {
    for (const c of list) {
      const old = ctxIndex.get(c.id);
      if (old && old.text.length >= c.text.length) continue;
      ctxIndex.set(c.id, c.text.length > CTX_TEXT_MAX ? Object.assign({}, c, { text: c.text.slice(0, CTX_TEXT_MAX) }) : c);
      ctxDirty = true;
    }
  }

  function ingest(json) {
    const res = P.extract(json);
    const now = Date.now();
    for (const u of res.users) {
      users.set(u.handle, u);
      recordHistory(u, now);
    }
    for (const t of res.tweets) {
      if (tweetSeen.has(t.id)) continue;
      tweetSeen.add(t.id);
      const s = stats.get(t.author) || { views: 0, interactions: 0 };
      s.views += t.views;
      s.interactions += t.interactions;
      stats.set(t.author, s);
    }
    if (res.me) meUid = res.me;
    mergeCtx(res.ctx);
    if (histDirty || ctxDirty) scheduleSave();
    return res;
  }

  function handleMessage(body) {
    let json;
    try { json = JSON.parse(body); } catch (_) { return; }
    ingest(json);
  }

  // ---------- 渲染 ----------
  function handleOf(container) {
    for (const a of container.querySelectorAll('a[role="link"][href^="/"]')) {
      const m = a.getAttribute("href").match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && a.textContent.trim().startsWith("@")) return m[1].toLowerCase();
    }
    return null;
  }

  function buildBadge(handle, compact) {
    const u = users.get(handle);
    if (!u) return null;
    const stat = stats.get(handle);
    const list = P.tags(u, stat, Date.now(), settings);

    const wrap = document.createElement("span");
    wrap.className = "fl-badge";
    wrap.dataset.flHandle = handle;
    // 徽标在名字链接里时,鼠标移上来不应触发 X 自己的资料悬浮卡:
    // 不让这些事件冒泡给 X(它靠这几个事件判断悬停),我们自己的详情卡直接监听徽标。
    for (const ev of ["mouseover", "mouseout", "pointerover", "pointerout", "mousemove", "pointermove"]) {
      wrap.addEventListener(ev, (e) => e.stopPropagation());
    }
    wrap.addEventListener("mouseenter", () => showTip(wrap));
    wrap.addEventListener("mouseleave", hideTip);

    const main = document.createElement("span");
    main.className = "fl-main" + (settings.tierColors ? " t" + P.tier(u.followers) : "");
    main.textContent = `${P.fmt(u.followers)} 粉丝`;
    wrap.append(main);

    if (settings.showRatio && u.following > 0) {
      const r = document.createElement("span");
      r.className = "fl-ratio";
      r.textContent = `比 ${P.fmtRatio(P.ratioOf(u))}`;
      wrap.append(r);
    }

    if (!compact) {
      for (const t of list.slice(0, settings.maxTags)) {
        const el = document.createElement("span");
        el.className = "fl-tag " + t.cls;
        el.textContent = t.text;
        wrap.append(el);
      }
    }
    return { wrap, list };
  }

  function sigOf(handle, compact) {
    const u = users.get(handle), s = stats.get(handle);
    return [u.followers, s ? s.views : 0, u.followedBy, u.iFollow, settingsVer, compact ? 1 : 0].join("|");
  }

  // ----- 推文头部:行内 / 单独一行 / 自动 -----
  const placed = new WeakMap();   // User-Name 元素 -> { badge, line, sig }

  // 头部整行(名字区 + 其它插件的小标 + 菜单)。结构不符就返回 null,调用方退回行内。
  function headerRow(un) {
    const row = un.parentElement && un.parentElement.parentElement && un.parentElement.parentElement.parentElement;
    const host = row && row.parentElement;
    if (!row || !host) return null;
    const rs = getComputedStyle(row), hs = getComputedStyle(host);
    return rs.display === "flex" && rs.flexDirection === "row" && hs.flexDirection === "column" ? row : null;
  }

  // 名字或 @ID 因为空间不够被省略(...)了吗
  function crowded(un, badge) {
    for (const n of un.querySelectorAll("*")) {
      if (n === badge || badge.contains(n)) continue;
      if (n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  }

  function placeBelow(un, badge) {
    const row = headerRow(un);
    if (!row) return null;
    const line = document.createElement("div");
    line.className = "fl-line";
    line.append(badge);
    row.after(line);
    return line;
  }

  function decorateTweet(un) {
    const handle = handleOf(un);
    if (!handle || !users.has(handle)) return;
    const sig = sigOf(handle, false);
    const rec = placed.get(un);
    if (rec && rec.badge.isConnected && rec.sig === sig) return;
    if (rec) { rec.badge.remove(); if (rec.line) rec.line.remove(); }

    const built = buildBadge(handle, false);
    if (!built) return;
    let line = null;
    if (settings.layout === "below") {
      line = placeBelow(un, built.wrap);
      if (!line) un.append(built.wrap);
    } else {
      un.append(built.wrap);
      // 自动:放进去之后名字被挤省略了,就挪到下一行(只判断这一次,不来回挪)
      if (settings.layout === "auto" && crowded(un, built.wrap)) line = placeBelow(un, built.wrap);
    }
    placed.set(un, { badge: built.wrap, line, sig });
  }

  // ----- 关注 / 粉丝列表里的用户行 -----
  function decorateCell(cell, anchor) {
    const handle = handleOf(cell);
    if (!handle || !users.has(handle)) return;
    const compact = !!cell.closest('[data-testid="sidebarColumn"]');
    const sig = sigOf(handle, compact);
    const old = cell.querySelector(".fl-badge");
    if (old && old.dataset.flHandle === handle && old.dataset.flSig === sig) return;
    if (old) old.remove();
    const built = buildBadge(handle, compact);
    if (!built) return;
    built.wrap.dataset.flSig = sig;
    if (anchor) anchor.append(built.wrap);
    cell.classList.toggle("fl-dim", settings.dimLowQuality && P.shouldDim(built.list));
  }

  function cleanup() {
    document.querySelectorAll(".fl-line").forEach((l) => l.remove());
    document.querySelectorAll(".fl-badge").forEach((b) => b.remove());
    document.querySelectorAll(".fl-dim").forEach((c) => c.classList.remove("fl-dim"));
    document.querySelectorAll(".fl-ctx").forEach((n) => n.remove());
  }

  function render() {
    if (!settings) return;
    if (!settings.enabled) { cleanup(); return; }
    document.querySelectorAll('article[data-testid="tweet"] [data-testid="User-Name"]').forEach(decorateTweet);
    document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
      const nameBlock = cell.querySelector('[dir="ltr"]')?.closest("div");
      decorateCell(cell, nameBlock && nameBlock.parentElement);
    });
    renderContexts();
    updateHud();
  }

  let timer = null;
  function scheduleRender() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; render(); }, 150);
  }

  new MutationObserver(scheduleRender).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ---------- 通知页:补出"被回复的是哪条" ----------
  // X 的回复通知只写一句"回复 @你",不显示被回复的正文。这里把本地索引里
  // 那条推文(正文 + 作者 + 时间)贴在回复正文上方,让上下文连起来。
  const isNotifPage = () => location.pathname === "/notifications";
  const ctxUrl = (handle, id) => `https://x.com/${handle || "i"}/status/${id}`;

  function themeOf() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
    return (+m[0] * 299 + +m[1] * 587 + +m[2] * 114) / 1000 < 128 ? "dark" : "light";
  }

  function myHandle() {
    if (meHandleCache) return meHandleCache;
    const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const m = btn && btn.textContent.match(/@([A-Za-z0-9_]{1,15})/);
    if (m) meHandleCache = m[1].toLowerCase();
    return meHandleCache;
  }

  const isMine = (c) => P.isMine(c, { uid: meUid, handle: myHandle() });

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // 新标签页打开,不动你正在看的通知列表
  function linkEl(href, text, cls) {
    const a = mk("a", cls || "fl-ctx-link", text);
    a.href = href;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(href, "_blank", "noopener");
    });
    return a;
  }

  function tweetIdOf(article) {
    const a = article.querySelector('a[href*="/status/"]');
    const m = a && a.getAttribute("href").match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function buildContextBlock(self) {
    const chain = P.resolveChain(self.id, ctxIndex, 2);
    const parent = chain[0] || null;
    const state = fetchState.get(self.id);
    const now = Date.now();

    const wrap = mk("div", "fl-ctx");
    wrap.dataset.flTheme = themeOf();
    // 整张通知卡是可点的,别让我们这块触发跳转
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      e.stopPropagation();
    });

    const head = mk("div", "fl-ctx-h");
    head.append(mk("span", "fl-ctx-badge", parent ? "被回复的推文" : "上下文未缓存"));
    const whoHandle = parent ? parent.handle : self.inReplyToHandle;
    if (whoHandle) {
      const mine = parent ? isMine(parent) : (myHandle() === whoHandle);
      head.append(mk("b", "fl-ctx-who", mine ? `你 @${whoHandle}` : `@${whoHandle}`));
      if (mine) head.append(mk("span", "fl-ctx-mine", "你说的"));
    }
    if (parent) head.append(mk("span", "fl-ctx-time", P.fmtTime(parent.createdAt, now)));
    wrap.append(head);

    const body = mk("div", "fl-ctx-t");
    if (parent) {
      body.textContent = P.trimText(parent.text, CTX_SHOW_MAX) || "(这条没有正文,可能是图片或视频)";
    } else if (state === "loading") {
      body.textContent = "正在取…";
    } else {
      body.textContent = (state && state.error) || "这条被回复的推文还没经过本地索引。";
    }
    wrap.append(body);

    if (parent && parent.inReplyTo) {
      const up = mk("div", "fl-ctx-up");
      up.append(mk("span", null, "↖ 这条也是回复,还有上文"));
      if (parent.inReplyToHandle) up.append(linkEl(ctxUrl(parent.inReplyToHandle, parent.inReplyTo), "跳上去 ↗", "fl-ctx-link"));
      wrap.append(up);
    }

    const foot = mk("div", "fl-ctx-f");
    if (parent) {
      foot.append(linkEl(ctxUrl(parent.handle, parent.id), "查看原帖 ↗"));
    } else if (self.inReplyTo) {
      foot.append(linkEl(ctxUrl(self.inReplyToHandle, self.inReplyTo), "原帖 ↗"));
      if (settings.contextFetch) {
        const btn = mk("button", "fl-ctx-load", state && state.error ? "重试" : "加载上下文");
        btn.type = "button";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          fetchState.delete(self.id);
          loadContext(self);
        });
        foot.append(btn);
      }
    }
    if (foot.childNodes.length) wrap.append(foot);
    return wrap;
  }

  function dropBlock(article) {
    const old = article.querySelector(".fl-ctx");
    if (old) old.remove();
    delete article.dataset.flCtx;
  }

  function decorateContext(article) {
    // 引用推文里嵌套的推文卡片不处理
    if (article.parentElement && article.parentElement.closest('article[data-testid="tweet"]')) return;
    const id = tweetIdOf(article);
    const self = id ? ctxIndex.get(id) : null;
    if (!self || !self.inReplyTo) { dropBlock(article); return; }

    const state = fetchState.get(self.id);
    const sig = [self.id, self.inReplyTo, settingsVer, ctxIndex.has(self.inReplyTo) ? "P" : "-",
      state === "loading" ? "L" : state && state.error ? "E" : "-"].join("|");
    if (article.dataset.flCtx === sig) return;
    dropBlock(article);

    const anchor = article.querySelector('[data-testid="tweetText"]') || article.querySelector('[role="group"]');
    if (!anchor) return;
    anchor.before(buildContextBlock(self));
    article.dataset.flCtx = sig;
  }

  function renderContexts() {
    if (!settings.notifContext || !isNotifPage()) {
      document.querySelectorAll(".fl-ctx").forEach((n) => n.remove());
      return;
    }
    document.querySelectorAll('article[data-testid="tweet"]').forEach(decorateContext);
  }

  // 用页面自己的登录态取一条推文。只有用户点了按钮才会走到这里。
  function requestTweet(tweetId) {
    return new Promise((resolve) => {
      const id = ++reqSeq;
      waiters.set(id, resolve);
      window.postMessage({ source: REQ_SOURCE, id, tweetId: String(tweetId) }, "*");
      setTimeout(() => {
        if (waiters.delete(id)) resolve({ error: "请求超时" });
      }, FETCH_TIMEOUT);
    });
  }

  async function loadContext(self) {
    if (!settings.contextFetch || fetchState.get(self.id) === "loading") return;
    fetchState.set(self.id, "loading");
    scheduleRender();
    const res = await requestTweet(self.inReplyTo);
    fetchState.delete(self.id);
    if (res && res.text) {
      try { ingest(JSON.parse(res.text)); } catch (_) {}
    }
    if (!ctxIndex.has(self.inReplyTo)) {
      fetchState.set(self.id, { error: (res && res.error) || "X 没有返回这条推文" });
    }
    scheduleRender();
  }

  // ---------- 调试条 ----------
  let hud = null;
  function applyDebug() {
    if (settings.debug && !hud) {
      hud = document.createElement("div");
      hud.id = "fl-hud";
      document.documentElement.append(hud);
    } else if (!settings.debug && hud) {
      hud.remove();
      hud = null;
    }
    updateHud();
  }
  function updateHud() {
    if (!hud) return;
    const shown = document.querySelectorAll(".fl-badge").length;
    const text = `FL 数据包:${msgCount} 用户:${users.size} 已显示:${shown} 上下文:${ctxIndex.size}`;
    if (hud.textContent !== text) hud.textContent = text;
  }

  // ---------- 悬停详情卡 ----------
  let tip = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function accountAge(createdAt, now) {
    const d = new Date(createdAt);
    if (isNaN(d)) return "";
    const months = Math.floor((now - d.getTime()) / (30.44 * 86400e3));
    const y = Math.floor(months / 12), m = months % 12;
    const span = y > 0 ? `${y} 年${m ? ` ${m} 个月` : ""}` : `${m} 个月`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")} · ${span}`;
  }

  function tipHtml(handle) {
    const u = users.get(handle);
    if (!u) return "";
    const now = Date.now();
    const stat = stats.get(handle);
    const er = P.engagementOf(stat);
    const rows = [];
    rows.push(["粉丝", u.followers.toLocaleString()]);
    rows.push(["关注", u.following.toLocaleString()]);
    rows.push(["粉丝/关注比", P.fmtRatio(P.ratioOf(u))]);
    if (u.tweets !== null && u.tweets !== undefined) rows.push(["推文数", Number(u.tweets).toLocaleString()]);
    if (u.createdAt) rows.push(["注册", accountAge(u.createdAt, now)]);
    rows.push(["互动率", er === null ? `<span class="dim">样本不足(需浏览量合计 ≥ 2000)</span>` : `${(er * 100).toFixed(2)}%`]);
    if (settings.trackHistory) {
      const d = P.deltaFrom(hist[handle], u.followers, now);
      if (d) {
        const sign = d.diff > 0 ? "+" : d.diff < 0 ? "" : "±";
        const cls = d.diff > 0 ? "up" : d.diff < 0 ? "down" : "";
        const pct = d.base > 0 ? ` (${sign}${((d.diff / d.base) * 100).toFixed(1)}%)` : "";
        rows.push([`近 ${d.days} 天`, `<span class="${cls}">${sign}${d.diff.toLocaleString()}${pct}</span>`]);
      } else {
        rows.push(["变化", `<span class="dim">已开始记录,明天起显示</span>`]);
      }
    }
    const rel = u.followedBy && u.iFollow ? "互相关注" : u.followedBy ? "TA 关注了你" : u.iFollow ? "你关注了 TA" : "";
    if (rel) rows.push(["关系", rel]);
    return `<div class="fl-tip-h">@${esc(handle)}</div>` +
      rows.map(([k, v]) => `<div class="fl-tip-r"><span>${k}</span><b>${v}</b></div>`).join("");
  }

  function showTip(badge) {
    if (!settings || !settings.hoverCard) return;
    const handle = badge.dataset.flHandle;
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "fl-tip";
      document.documentElement.append(tip);
    }
    tip.innerHTML = tipHtml(handle);
    tip.dataset.theme = themeOf();
    tip.style.display = "block";
    const r = badge.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8);
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function hideTip() { if (tip) tip.style.display = "none"; }

  window.addEventListener("scroll", hideTip, { passive: true });

  init();
})();
