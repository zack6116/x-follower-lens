# 隐私政策 / Privacy Policy

**粉丝透镜 Follower Lens** · 最后更新:2026-10-11

## 中文

**一句话:这个扩展不收集、不上传、不出售你的任何数据。**

### 它会读取什么
扩展只在 `x.com` 和 `twitter.com` 运行。它读取的是 **X 网页自己已经收到的数据**(用户名、粉丝数、关注数、注册时间、推文互动数、推文正文与其回复关系、你与对方的关注关系),用来在页面上显示徽标、悬停卡片,以及在通知页还原"别人回复的是你的哪条推文"。

### 它会保存什么
以下内容保存在你浏览器的本地存储(`chrome.storage.local`)里,不会离开你的设备:
- **你的设置**(各开关、徽标位置等)。
- **粉丝数历史记录**:你浏览过的账号的用户名与粉丝数、记录时间,用于显示"近 7 天变化"。最多保存 3000 个账号、每个账号 40 个数据点。你可以随时在扩展的设置面板里点"清除记录"删除,或关闭"本地记录粉丝数变化"。
- **推文索引**:你刷到过的推文的编号、正文(最多截取 400 字)、作者与回复关系,用于通知页显示回复上下文。最多保存 800 条,超出后按推文时间丢弃最旧的。可在设置面板里点"清除索引"删除,或关闭"回复上下文"。

### 它不会做什么
- 不向任何服务器发送数据,不含任何统计、广告或跟踪代码。所有数据只存在你的浏览器里。
- **默认不主动向 X 发起网络请求**,只读取页面本来就在收发的数据。唯一例外是:通知页某条回复的被回复推文不在本地索引里时,你会看到一个"加载上下文"按钮,**只有你点它**,扩展才会用你页面当前的登录态向 X 请求这一条推文(仅此一条,不批量、不定时)。不想让它联网,可在设置面板里关掉"允许联网补取"。
- 不读取你的密码、私信或登录凭据。补取请求复用页面自己的会话,扩展不会保存、也不会外传这些凭据。
- 不使用远程托管的代码,所有代码都在安装包里。

### 权限说明
- `storage`:保存上述设置和历史记录。
- 在 `x.com` / `twitter.com` 运行的内容脚本:读取页面数据并显示徽标。

### 联系方式
问题或建议请到 GitHub 提 issue:https://github.com/zackzhangkai/x-follower-lens/issues

---

## English

**In short: this extension does not collect, upload, or sell any of your data.**

**What it reads.** It runs only on `x.com` and `twitter.com`. It reads data that the X web page has *already received* (usernames, follower/following counts, account creation date, tweet engagement counts, tweet text and reply relationships, and your follow relationship with each account) to render badges, hover cards, and — on the notifications page — the tweet that a reply was answering.

**What it stores.** The following is saved in your browser's local storage (`chrome.storage.local`) and never leaves your device: (1) your settings; (2) a follower-count history for accounts you have browsed (username, follower count, timestamp; capped at 3,000 accounts and 40 data points each) used to show 7-day changes; (3) a tweet index (tweet id, up to 400 characters of text, author, and reply relationship; capped at 800 tweets, oldest dropped first) used for reply context on the notifications page. You can delete it anytime with "Clear history" / "Clear index" in the extension popup, or turn the corresponding features off.

**What it does not do.** It sends no data to any server and contains no analytics, ads, or trackers. By default it makes no network requests of its own; it only reads data the page is already sending and receiving. The one exception: when the tweet being replied to is missing from the local index, the notifications page shows a "Load context" button — only if you click it does the extension request that single tweet from X, reusing the session the page is already logged in with. No bulk or background fetching. Turn off "Allow online lookup" to disable it entirely. It does not read passwords, direct messages, or credentials. It uses no remotely hosted code.

**Permissions.** `storage` (settings and history) and content scripts on `x.com` / `twitter.com`.

**Contact.** Open an issue at https://github.com/zackzhangkai/x-follower-lens/issues
