// 运行在页面主世界:只读 X 自己发出的 GraphQL 响应,不主动发任何请求。
// 例外:用户在通知页点"加载上下文"时,这里会用页面自己的登录态补取一条推文(见文件末尾)。
(() => {
  const SOURCE = "follower-lens";
  const REQ = "follower-lens-req";
  const RES = "follower-lens-res";
  const isGraphql = (url) => typeof url === "string" && url.includes("/i/api/graphql/");

  const emit = (text) => {
    window.postMessage({ source: SOURCE, body: text }, "*");
  };

  // X 的 queryId / features 会随发版变动,所以不硬编码:
  // 记下每种操作最近一次的完整 URL,需要补取时照抄,只换 variables 里的 tweetId。
  const templates = Object.create(null);

  const authOf = (headers) => {
    if (!headers) return null;
    try {
      if (typeof headers.get === "function") return headers.get("authorization");
      for (const k in headers) if (k.toLowerCase() === "authorization") return headers[k];
    } catch (_) {}
    return null;
  };

  function remember(url, auth) {
    if (!isGraphql(url)) return;
    const m = String(url).match(/\/i\/api\/graphql\/[^/]+\/([A-Za-z0-9_]+)/);
    if (!m) return;
    const prev = templates[m[1]];
    const token = auth || (prev && prev.auth) || null;
    if (prev && prev.url === url && prev.auth === token) return;
    templates[m[1]] = { url: String(url), auth: token };
  }

  const urlOf = (a) => (typeof a === "string" ? a : a && a.url);

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    try { remember(urlOf(args[0]), authOf(args[1] && args[1].headers)); } catch (_) {}
    const res = await origFetch.apply(this, args);
    try {
      if (isGraphql(urlOf(args[0]))) res.clone().text().then(emit).catch(() => {});
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (String(name).toLowerCase() === "authorization") this.__flAuth = value; } catch (_) {}
    return origSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isGraphql(url)) {
      this.addEventListener("load", () => {
        try {
          remember(url, this.__flAuth);
          emit(this.responseText);
        } catch (_) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // ---------- 按需补取(仅由用户点击触发) ----------
  const ct0 = () => {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? m[1] : "";
  };

  // X 取单条推文有两个操作:直接取一条(TweetResultByRestId),或取整段会话(TweetDetail)。
  // 后者返回的会话里通常还带着上文,所以哪个可用就用哪个。
  const TWEET_OPS = ["TweetResultByRestId", "TweetDetail"];

  // 不同操作里目标推文的变量名不一样(tweetId / focalTweetId),不硬编码:凡是名字以
  // tweetId 结尾的都换掉。
  function setTweetId(vars, tweetId) {
    let hit = false;
    for (const k of Object.keys(vars)) {
      if (/tweet_?id$/i.test(k)) { vars[k] = String(tweetId); hit = true; }
    }
    if (!hit) vars.tweetId = String(tweetId);
  }

  async function fetchTweet(tweetId) {
    const op = TWEET_OPS.find((name) => templates[name]);
    if (!op) return { error: "这个标签页还没向 X 取过单条推文,先在 X 里打开任意一条推文,回来再点" };
    const tpl = templates[op];

    let url;
    let vars;
    try {
      url = new URL(tpl.url, location.origin);
      vars = JSON.parse(url.searchParams.get("variables"));
    } catch (_) {
      return { error: "X 的请求参数读不出来" };
    }
    // variables 里带着 X 当前那套开关,只替换目标推文
    setTweetId(vars, tweetId);
    url.searchParams.set("variables", JSON.stringify(vars));

    const headers = { "x-twitter-active-user": "yes", "content-type": "application/json" };
    const csrf = ct0();
    if (csrf) headers["x-csrf-token"] = csrf;
    if (tpl.auth) headers.authorization = tpl.auth;
    if (!tpl.auth && !csrf) return { error: "拿不到登录凭据" };

    const r = await origFetch.call(window, url.toString(), { headers, credentials: "include" });
    if (!r.ok) return { error: "X 返回 HTTP " + r.status };
    return { text: await r.text() };
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.source !== REQ) return;
    const { id, tweetId } = e.data;
    let payload;
    try {
      payload = await fetchTweet(tweetId);
    } catch (err) {
      payload = { error: String((err && err.message) || err) };
    }
    window.postMessage(Object.assign({ source: RES, id, tweetId }, payload), "*");
  });
})();
