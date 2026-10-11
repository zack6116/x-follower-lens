// 纯函数:从 GraphQL JSON 里递归提取用户与推文统计,并判断质量标签。
// 字段解析集中在这里,X 改版时只改此文件。
(function (root) {
  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

  const DEFAULTS = {
    enabled: true,        // 总开关
    showRatio: false,     // 徽标里显示粉丝/关注比
    tierColors: true,     // 按粉丝量分级配色
    hoverCard: true,      // 悬停详情卡
    trackHistory: true,   // 本地记录粉丝数变化
    dimLowQuality: true,  // 在关注/粉丝列表里淡化疑似互粉号、低活跃号
    layout: "auto",       // 徽标位置:auto 自动 / inline 行内 / below 单独一行
    maxTags: 3,           // 徽标里最多显示几个标签(0 = 只显示粉丝数)
    notifContext: true,   // 通知页显示"被回复的是哪条"
    contextFetch: true,   // 缓存没命中时,点按钮用页面登录态补取一次
    debug: false,         // 左下角调试条
    tags: {
      relation: true,     // 互关 / 关注了你
      bigV: true,
      farm: true,         // 疑似互粉号
      newAcct: true,
      oldAcct: true,
      engaged: true,      // 高互动
      lowActive: true,
    },
  };

  function mergeSettings(saved) {
    const s = saved || {};
    return Object.assign({}, DEFAULTS, s, { tags: Object.assign({}, DEFAULTS.tags, s.tags) });
  }

  function readUser(u) {
    const legacy = u.legacy || {};
    const core = u.core || {};
    const handle = core.screen_name || legacy.screen_name;
    if (!handle) return null;
    const rc = u.relationship_counts || {};
    const followers = rc.followers ?? legacy.followers_count ?? u.followers_count;
    const following = rc.following ?? legacy.friends_count ?? u.friends_count;
    if (followers === undefined) return null;
    const rp = u.relationship_perspectives || {};
    const tc = u.tweet_counts || {};
    return {
      handle: String(handle).toLowerCase(),
      name: core.name || legacy.name || "",
      followers: num(followers),
      following: num(following),
      tweets: tc.tweets ?? legacy.statuses_count ?? null,
      createdAt: core.created_at || legacy.created_at || null,
      followedBy: rp.followed_by === true,   // 对方关注了我
      iFollow: rp.following === true,        // 我关注了对方
    };
  }

  // ---------- 推文上下文(通知页里"谁回复了哪条") ----------
  // 长文(Note Tweet)的正文不在 legacy 里
  function noteText(t) {
    const nt = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
    return (nt && nt.text) || null;
  }

  const normText = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // 推文作者。X 有时把 User 再包一层(result / legacy),这里都兼容。
  function authorOf(t) {
    const r = t.core && t.core.user_results && t.core.user_results.result;
    if (!r) return { handle: "", name: "", uid: "" };
    const u = (r.core || r.legacy) ? r : (r.result || {});
    const c = u.core || u.legacy || {};
    const handle = c.screen_name;
    return {
      handle: handle ? String(handle).toLowerCase() : "",
      name: c.name || "",
      uid: u.rest_id ? String(u.rest_id) : "",
    };
  }

  // 一条推文 -> 上下文记录。通知页靠 inReplyTo 找到"被回复的那条"。
  function readContext(t) {
    if (!t || !t.rest_id) return null;
    const a = authorOf(t);
    if (!a.handle) return null;
    const legacy = t.legacy || {};
    const created = legacy.created_at || (t.core && t.core.created_at) || null;
    const ts = created ? Date.parse(created) : NaN;
    return {
      id: String(t.rest_id),
      handle: a.handle,
      name: a.name,
      uid: a.uid,
      text: normText(noteText(t) || legacy.full_text || legacy.text || ""),
      createdAt: isNaN(ts) ? null : ts,
      inReplyTo: legacy.in_reply_to_status_id_str ? String(legacy.in_reply_to_status_id_str) : null,
      inReplyToHandle: legacy.in_reply_to_screen_name ? String(legacy.in_reply_to_screen_name).toLowerCase() : null,
    };
  }

  // 当前登录用户。通知接口把它放在 viewer_v2 下,只有 rest_id,没有 handle。
  function viewerId(json) {
    const d = json && json.data;
    const v = d && (d.viewer_v2 || d.viewer);
    const r = v && v.user_results && v.user_results.result;
    return r && r.rest_id ? String(r.rest_id) : null;
  }

  function readTweet(t, author) {
    const legacy = t.legacy || {};
    if (!t.rest_id || legacy.favorite_count === undefined) return null;
    const views = t.views && t.views.count !== undefined ? num(t.views.count) : 0;
    return {
      id: t.rest_id,
      author,
      views,
      interactions:
        num(legacy.favorite_count) + num(legacy.retweet_count) +
        num(legacy.reply_count) + num(legacy.quote_count),
    };
  }

  // 同一条推文可能出现多次(如同时挂在 tweet_results 和 target_objects 下),取正文最全的那份
  function mergeContexts(map, list) {
    for (const c of list) {
      const old = map.get(c.id);
      if (!old || c.text.length > old.text.length) map.set(c.id, c);
    }
  }

  // 返回 { users: [...], tweets: [...], ctx: [...], me: 本人 rest_id }
  function extract(json) {
    const users = [];
    const tweets = [];
    const ctxById = new Map();
    const seen = new WeakSet();

    (function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }

      if (node.__typename === "User") {
        const u = readUser(node);
        if (u) users.push(u);
      } else if (node.__typename === "Tweet" || node.__typename === "TweetWithVisibilityResults") {
        // 可见性受限的推文多包一层 tweet
        const t = node.__typename === "Tweet" ? node : node.tweet;
        if (t) {
          const c = readContext(t);
          if (c) mergeContexts(ctxById, [c]);
          if (t.core && t.core.user_results) {
            const author = readUser(t.core.user_results.result);
            if (author) {
              const tw = readTweet(t, author.handle);
              if (tw) tweets.push(tw);
            }
          }
        }
      }
      for (const k in node) walk(node[k]);
    })(json);

    return { users, tweets, ctx: [...ctxById.values()], me: viewerId(json) };
  }

  const ratioOf = (u) => (u.following > 0 ? u.followers / u.following : u.followers);

  function engagementOf(stat) {
    if (!stat || stat.views < 2000) return null;
    return stat.interactions / stat.views;
  }

  // 质量标签。阈值是经验值,放在这里方便调。按展示优先级排序。
  function tags(user, stat, now, cfg) {
    const on = (cfg && cfg.tags) || DEFAULTS.tags;
    const out = [];
    const { followers, following } = user;
    const ratio = ratioOf(user);

    if (on.relation) {
      if (user.followedBy && user.iFollow) out.push({ key: "relation", text: "互关", cls: "rel" });
      else if (user.followedBy) out.push({ key: "relation", text: "关注了你", cls: "rel" });
    }
    if (on.bigV && followers >= 10000 && ratio >= 10) out.push({ key: "bigV", text: "大V", cls: "hi" });
    if (on.farm && following >= 1000 && ratio > 0.8 && ratio < 1.25 && followers < 5000)
      out.push({ key: "farm", text: "疑似互粉号", cls: "warn" });

    const days = user.createdAt ? (now - new Date(user.createdAt).getTime()) / 86400000 : null;
    if (on.newAcct && days !== null && days >= 0 && days < 90) out.push({ key: "newAcct", text: "新号", cls: "warn" });

    const er = engagementOf(stat);
    if (er !== null) {
      if (on.engaged && er >= 0.03) out.push({ key: "engaged", text: "高互动", cls: "hi" });
      else if (on.lowActive && er < 0.001 && followers >= 5000)
        out.push({ key: "lowActive", text: "低活跃", cls: "warn" });
    }
    // 老号信息量最低,排最后(徽标最多展示前 3 个)
    if (on.oldAcct && days !== null && days > 365 * 8) out.push({ key: "oldAcct", text: "老号", cls: "" });
    return out;
  }

  // 粉丝量分级 0..4,用于徽标配色
  function tier(followers) {
    if (followers >= 1e6) return 4;
    if (followers >= 1e5) return 3;
    if (followers >= 1e4) return 2;
    if (followers >= 1e3) return 1;
    return 0;
  }

  // 1 万以内显示精确值,以上用"万"、"亿"
  function fmt(n) {
    if (n < 10000) return String(n);
    if (n < 1e8) return (n / 1e4).toFixed(n < 1e5 ? 2 : 1).replace(/\.?0+$/, "") + "万";
    return (n / 1e8).toFixed(2).replace(/\.?0+$/, "") + "亿";
  }

  function fmtRatio(r) {
    return r >= 100 ? String(Math.round(r)) : r >= 10 ? r.toFixed(0) : r.toFixed(1);
  }

  // 淡化条件:疑似互粉号或低活跃号(且对应标签开关打开)
  function shouldDim(tagList) {
    return tagList.some((t) => t.key === "farm" || t.key === "lowActive");
  }

  // 历史变化:在 history(数组 [[ts, followers], ...])里找约 7 天前的基准点
  function deltaFrom(history, current, now) {
    if (!history || history.length < 2) return null;
    const MIN_AGE = 20 * 3600e3;
    const WEEK = 7 * 86400e3;
    let best = null;
    for (const [ts, f] of history) {
      const age = now - ts;
      if (age < MIN_AGE) continue;
      if (!best || Math.abs(age - WEEK) < Math.abs(now - best.ts - WEEK)) best = { ts, f };
    }
    if (!best) return null;
    return { days: Math.max(1, Math.round((now - best.ts) / 86400e3)), diff: current - best.f, base: best.f };
  }

  // ---------- 上下文还原 ----------

  // 顺着"回复了谁"往上找,返回 [直接父推文, 祖父, ...],索引里缺哪层就停在哪层
  function resolveChain(id, index, maxHops) {
    const out = [];
    const limit = maxHops || 3;
    let cur = index.get(String(id));
    while (cur && cur.inReplyTo && out.length < limit) {
      const parent = index.get(String(cur.inReplyTo));
      if (!parent) break;
      out.push(parent);
      cur = parent;
    }
    return out;
  }

  // 引用块里正文最多显示多少个字
  function trimText(s, max) {
    const t = normText(s);
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  // 相对时间,超过 7 天显示日期
  function fmtTime(ts, now) {
    if (!ts) return "";
    const diff = now - ts;
    if (diff < 0) return "";
    const min = diff / 60000;
    if (min < 1) return "刚刚";
    if (min < 60) return `${Math.floor(min)} 分钟前`;
    const hr = min / 60;
    if (hr < 24) return `${Math.floor(hr)} 小时前`;
    const day = hr / 24;
    if (day < 7) return `${Math.floor(day)} 天前`;
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // 这条是不是你自己发的。uid(接口)优先,handle(页面)兜底。
  function isMine(c, me) {
    if (!c) return false;
    if (me && me.uid && c.uid) return String(c.uid) === String(me.uid);
    if (me && me.handle && c.handle) return c.handle === String(me.handle).toLowerCase();
    return false;
  }

  const api = {
    DEFAULTS, mergeSettings, extract, tags, tier, fmt, fmtRatio, ratioOf, engagementOf, shouldDim, deltaFrom,
    readContext, resolveChain, trimText, fmtTime, isMine,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.FollowerLensParse = api;
})(typeof window !== "undefined" ? window : globalThis);
