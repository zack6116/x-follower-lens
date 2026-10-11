// 按 X 通知接口真实响应结构造的假数据(纯虚构,不含任何真实账号内容)。
// 结构对照:NotificationsTimeline 的两种 itemContent ——
//   通知型:itemContent.template.target_objects[0].tweet_results.result
//   推文型:itemContent.tweet_results.result
const T = {
  me: "1000000000000000001",
  other: "1000000000000000002",
  third: "1000000000000000003",
  rootTweet: "2000000000000000001",   // 别人的原帖
  myReply: "2000000000000000002",     // 我回复了原帖
  theirReply: "2000000000000000003",  // 别人回复了我的回复(通知里看到的那条)
  likedTweet: "2000000000000000004",  // 我另一条被点赞的推文
};

function user(uid, handle, name) {
  // 真实响应里用户节点一定带 relationship_counts,readUser 靠它取粉丝数
  return {
    __typename: "User",
    rest_id: uid,
    core: { screen_name: handle, name, created_at: "2020-01-01T00:00:00.000Z" },
    relationship_counts: { followers: 100, following: 100 },
    relationship_perspectives: { followed_by: false, following: true },
    tweet_counts: { tweets: 10 },
  };
}

function tweet({ id, uid, handle, name, text, createdAt, inReplyTo, inReplyToHandle, note }) {
  const legacy = {
    full_text: text,
    created_at: createdAt,
    favorite_count: 1,
    retweet_count: 0,
    reply_count: 0,
    quote_count: 0,
    conversation_id_str: inReplyTo || id,
  };
  if (inReplyTo) legacy.in_reply_to_status_id_str = inReplyTo;
  if (inReplyToHandle) legacy.in_reply_to_screen_name = inReplyToHandle;
  const node = { __typename: "Tweet", rest_id: id, core: { user_results: { result: user(uid, handle, name) } }, legacy, views: { count: "100" } };
  if (note) node.note_tweet = { note_tweet_results: { result: { text: note } } };
  return node;
}

const rootTweet = tweet({
  id: T.rootTweet, uid: T.other, handle: "someone", name: "某人",
  text: "原帖正文", createdAt: "2026-10-10T02:00:00.000Z",
});

const myReply = tweet({
  id: T.myReply, uid: T.me, handle: "me", name: "我",
  text: "我这边也踩过:隔夜一句「继续」,第二天它把昨天的上下文全丢了。",
  createdAt: "2026-10-10T03:00:00.000Z",
  inReplyTo: T.rootTweet, inReplyToHandle: "someone",
});

const theirReply = tweet({
  id: T.theirReply, uid: T.third, handle: "krou", name: "Krou",
  text: "对,我也是这么干的。", createdAt: "2026-10-10T04:00:00.000Z",
  inReplyTo: T.myReply, inReplyToHandle: "me",
});

const likedTweet = tweet({
  id: T.likedTweet, uid: T.me, handle: "me", name: "我",
  text: "东西跑通了,别急着关窗口。", createdAt: "2026-10-10T01:00:00.000Z",
  note: "东西跑通了,别急着关窗口。让它把怎么运行写成三行笔记,下次就不用重新猜。",
});

// 一条被"可见性受限"包一层的推文
const wrapped = {
  __typename: "TweetWithVisibilityResults",
  tweet: tweet({
    id: "2000000000000000005", uid: T.third, handle: "hidden", name: "受限",
    text: "受限推文正文", createdAt: "2026-10-10T05:00:00.000Z",
  }),
};

function notification(inner) {
  return { content: { itemContent: { itemType: "TimelineNotification", notification_icon: "heart_icon", rich_message: { text: "某人 喜欢了你的帖子" }, template: { __typename: "TimelineNotificationAggregateUserActions", target_objects: inner } } } };
}

function timelineItem(node) {
  return { content: { itemContent: { itemType: "TimelineItem", tweetDisplayType: "Tweet", tweet_results: { result: node } } } };
}

const payload = {
  data: {
    viewer_v2: {
      user_results: {
        result: {
          __typename: "User",
          rest_id: T.me,
          notification_timeline: {
            timeline: {
              instructions: [
                { type: "TimelineAddEntries", entries: [
                  { content: { __typename: "TimelineTimelineCursor" } },
                  notification([{ tweet_results: { result: likedTweet } }]),
                  // 被回复的那条也出现在通知里(X 会把"你的帖子被点赞"的目标一起带上)
                  notification([{ tweet_results: { result: myReply } }]),
                  timelineItem(theirReply),
                  notification([{ tweet_results: { result: wrapped } }]),
                  timelineItem(rootTweet),
                ] },
              ],
            },
          },
        },
      },
    },
  },
};

// 模拟"点了加载上下文"之后,X 返回的单条推文
const parentPayload = { data: { tweetResult: { result: myReply } } };

module.exports = { T, payload, parentPayload, rootTweet, myReply, theirReply, likedTweet };
