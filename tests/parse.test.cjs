const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const P = require(path.join(__dirname, "..", "parse.js"));
const F = require("./fixtures.js");

const byId = (ctx) => new Map(ctx.map((c) => [c.id, c]));

test("extract:从通知响应里收出推文上下文", () => {
  // Act
  const res = P.extract(F.payload);
  const ctx = byId(res.ctx);

  // Assert
  assert.equal(res.me, F.T.me, "应识别出登录用户");
  assert.ok(ctx.has(F.T.theirReply), "应收到别人那条回复");
  assert.ok(ctx.has(F.T.myReply), "应收到被回复的那条(挂在通知的 target_objects 下)");
  assert.ok(ctx.has(F.T.likedTweet), "应收到被点赞的推文");
});

test("extract:回复推文带出被回复的推文 id 和作者", () => {
  // Arrange
  const ctx = byId(P.extract(F.payload).ctx);

  // Act
  const reply = ctx.get(F.T.theirReply);

  // Assert
  assert.equal(reply.inReplyTo, F.T.myReply);
  assert.equal(reply.inReplyToHandle, "me");
  assert.equal(reply.handle, "krou");
});

test("extract:兼容 TweetWithVisibilityResults 包装", () => {
  // Act
  const ctx = byId(P.extract(F.payload).ctx);

  // Assert
  assert.equal(ctx.get("2000000000000000005").text, "受限推文正文");
});

test("extract:长文取 note_tweet 的正文", () => {
  // Act
  const ctx = byId(P.extract(F.payload).ctx);

  // Assert
  assert.match(ctx.get(F.T.likedTweet).text, /三行笔记/);
});

test("extract:单条推文的响应(补取回来的)也能解析", () => {
  // Act
  const ctx = byId(P.extract(F.parentPayload).ctx);

  // Assert
  assert.equal(ctx.get(F.T.myReply).inReplyTo, F.T.rootTweet);
});

test("extract:仍然给出用户和互动数据(原有行为不回归)", () => {
  // Act
  const res = P.extract(F.payload);

  // Assert
  assert.ok(res.users.length >= 3);
  assert.ok(res.tweets.some((t) => t.id === F.T.theirReply));
});

test("resolveChain:沿着回复关系往上找出被回复的推文", () => {
  // Arrange
  const ctx = byId(P.extract(F.payload).ctx);

  // Act
  const chain = P.resolveChain(F.T.theirReply, ctx, 3);

  // Assert
  assert.deepEqual(chain.map((c) => c.id), [F.T.myReply, F.T.rootTweet], "先直接父推文,再往上是根帖");
  assert.match(chain[0].text, /隔夜一句/);
});

test("resolveChain:maxHops 限制往上找几层", () => {
  // Arrange
  const ctx = byId(P.extract(F.payload).ctx);

  // Act / Assert
  assert.deepEqual(P.resolveChain(F.T.theirReply, ctx, 1).map((c) => c.id), [F.T.myReply]);
});

test("resolveChain:中间断链就停在那里,不跳过去", () => {
  // Arrange
  const ctx = byId(P.extract(F.payload).ctx);
  ctx.delete(F.T.myReply);

  // Act / Assert
  assert.deepEqual(P.resolveChain(F.T.theirReply, ctx, 3), []);
});

test("resolveChain:找不到父推文时返回空数组,不抛错", () => {
  // Arrange
  const ctx = new Map();

  // Act / Assert
  assert.deepEqual(P.resolveChain("123", ctx, 3), []);
});

test("trimText:折叠空白并按长度截断", () => {
  // Act
  const short = P.trimText("  换行\n和   空格  ", 40);
  const long = P.trimText("一二三四五", 4);

  // Assert
  assert.equal(short, "换行 和 空格");
  assert.equal(long, "一二三…");
});

test("fmtTime:按时间差给出相对时间", () => {
  // Arrange
  const now = Date.parse("2026-10-11T12:00:00.000Z");

  // Act / Assert
  assert.equal(P.fmtTime(Date.parse("2026-10-11T11:58:00.000Z"), now), "2 分钟前");
  assert.equal(P.fmtTime(Date.parse("2026-10-11T09:00:00.000Z"), now), "3 小时前");
  assert.equal(P.fmtTime(Date.parse("2026-10-09T12:00:00.000Z"), now), "2 天前");
  assert.equal(P.fmtTime(Date.parse("2026-09-01T12:00:00.000Z"), now), "2026-09-01");
  assert.equal(P.fmtTime(null, now), "");
});

test("isMine:优先按 uid 判断,退化到 handle", () => {
  // Arrange
  const ctx = byId(P.extract(F.payload).ctx);

  // Act / Assert
  assert.equal(P.isMine(ctx.get(F.T.myReply), { uid: F.T.me }), true);
  assert.equal(P.isMine(ctx.get(F.T.theirReply), { uid: F.T.me }), false);
  assert.equal(P.isMine({ handle: "me" }, { handle: "Me" }), true, "handle 比较应忽略大小写");
  assert.equal(P.isMine(null, { uid: F.T.me }), false);
});

test("默认设置里通知上下文是开的", () => {
  // Act
  const s = P.mergeSettings();

  // Assert
  assert.equal(s.notifContext, true);
  assert.equal(s.contextFetch, true);
});

test("mergeSettings:部分保存也能补全新增的开关", () => {
  // Act
  const s = P.mergeSettings({ maxTags: 1 });

  // Assert
  assert.equal(s.maxTags, 1);
  assert.equal(s.notifContext, true);
});
