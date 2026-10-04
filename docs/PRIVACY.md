# Privacy and permissions / 隐私与权限

[Back to the README](../README.md) · [中文](#中文)

These details describe source version **3.12.6**. This extension has no analytics, advertising code, extension account, or developer-operated translation server. YouTube, Google, your browser, and dictionary websites have their own data practices.

## What leaves your browser

| Feature | Destination | Data sent and when |
| --- | --- | --- |
| Caption loading | YouTube | Requests for the video's original and translated caption tracks. The extension uses the player's existing caption request. |
| Bilibili caption loading | Bilibili API and approved HTTPS subtitle CDNs | Reads tracks for the current video and part. Only `api.bilibili.com` receives page session credentials; subtitle CDN requests omit credentials. |
| Automatic word timing | YouTube | When word times are missing, a same-language automatic caption track may also be requested and matched locally. Disabling word highlighting skips this additional request. Approximate progress is calculated locally from syllable counts, punctuation and a speaking pace measured from the video's own captions. No audio is captured, transcribed, or sent for this feature. |
| Whole-sentence translation | YouTube, with Google fallback | Prefers a translated YouTube track. If it is still pending after 0.35 seconds or unavailable, Google receives the current sentence and a look-ahead of up to two sentences. |
| Per-sentence translation | Google Translate endpoint | Sentence text, source language when known, and chosen target language. |
| Fast display | YouTube and Google | Starts both paths immediately; Google can receive the current sentence and next two sentences while the YouTube track loads. |
| Native-caption preview | Google | In any translation mode, visible native-caption text can be sent before the full source track is ready. |
| Hover word lookup | Google | The hovered word, source language when known, and target language after about 0.4 seconds of hovering. This feature can be switched off. |
| German Assistant link | German Assistant (`godic.net`) | The word in the dictionary URL, only after you click the link. Hovering does not open the dictionary website. |
| Optional speech recognition | Your local Deutsch Overlay bridge | After an explicit start and a confirmed absence of native tracks, audio from the current tab is sent to the configured loopback bridge with its token. The extension does not send this audio to a cloud ASR provider. |
| Optional audio alignment | Your own computer, plus Hugging Face if the model is not cached | The original captions and the video's audio, or a local media file you choose, are read by a helper process running on `127.0.0.1`. Nothing is sent to a project server. The first analysis of a language downloads the speech model (about 360 MB) from Hugging Face; no account, token, or cookie is used, and no audio is uploaded to Hugging Face. This runs only when you start the helper and choose the audio mode. |

Google translation uses `https://translate.googleapis.com/translate_a/single`, an **unofficial free endpoint**. It may be unavailable or rate-limited. No API key is requested or stored. External requests use the normal browser networking environment; providers can receive network metadata such as your IP address. The optional audio helper is a separate local program: it is not installed, started, or updated by the extension, and it opens no inbound port beyond loopback.

## What is stored

- **Preferences:** language, styles, layout, and study settings are written to `chrome.storage.sync`. The optional local recognizer address may sync, but its bridge token is kept in extension-origin IndexedDB (`ytds-private`, `credentials`) and is never synced. Video-page content scripts cannot open that extension-origin database; only the worker handles credential reads and writes, with sender checks. Unsynced edits and the next retry time are staged in `chrome.storage.local` under `settingsPendingV1`, so changes remain usable after closing the popup or reaching a sync limit. The background batches writes at least 2.5 seconds apart and resumes pending writes when active. Whether preferences sync between devices depends on the browser's extension-sync settings. Browser storage is separate from this GitHub repository.
- **Saved sentences:** `chrome.storage.local`, under `studyCardsV1`. Cards contain the video ID/title, sentence timing and index, original text, available translation, source language, learned state, and save time. They do **not** sync automatically.
- **Temporary caches:** caption and translation results can be kept in extension/page memory to reduce repeated requests. They are not sent to a project server.
- **Audio-alignment results:** word times produced by the optional helper are kept in `chrome.storage.local` under `audioTimingCacheV1`, limited to a few recent videos and a bounded size, keyed by video id, source language, a caption-track hash, model/helper version, audio start offset and — for an imported file — that file's size and the hash of its first 4 MiB, which lets the extension tell one recording from another. The hash is computed locally and is not a fingerprint of your device. The helper separately keeps the downloaded audio, the model, and its results under `%LOCALAPPDATA%\YT Dual Subs\audio-alignment`. Deleting either location only means an analysis has to run again.
- **Exports:** SRT, saved-sentence JSON, and Anki TSV files are downloaded to the location your browser uses. TSV includes sentence text, translations, video IDs/titles, time links and tags; it contains no bridge token. You control whether those files are shared or synchronized elsewhere.

Legacy tokens migrate from sync, pending, or the old local `bridgeConfigV1` to the private database when the worker starts. The migration commits before old copies are cleared; an existing private value, including an explicitly cleared token, wins. Tokens are excluded from content-script settings and page-status messages. This origin isolation is not encryption or Windows Credential Manager; protect access to your browser profile. Resetting settings clears the token without deleting sentence cards.

**Back up saved sentences before uninstalling.** Use **Export saved / Import saved** in the popup. Import merges cards with the existing collection; resetting subtitle settings preserves saved cards. Uninstalling removes local extension storage.

## Why the extension needs these permissions

| Manifest entry | Purpose |
| --- | --- |
| `storage` | Save preferences and your local sentence collection. |
| `tabCapture`, `offscreen` | Capture the explicitly selected tab for optional recognition and keep its audio audible while the popup is closed. |
| `https://translate.googleapis.com/*` | Let the service worker request sentence and word translations. |
| Content scripts on `https://www.youtube.com/*` | Read caption data and native-caption text, follow playback timing, and draw the subtitle overlay. |
| Content scripts on `https://www.bilibili.com/video/*` | Read current video/part caption metadata and draw the subtitle overlay. |
| Optional HTTP/HTTPS patterns for `127.0.0.1` and `localhost` | Connect to the local alignment helper or recognizer. Alignment requests access on start; recognition requests its configured host when you click **Check connection**. |

The extension does not request access to all websites, browser history, cookies, or downloaded files. Its declared content scripts run on YouTube and Bilibili video pages; the page-world script observes caption-related network activity to obtain the player's caption URL. Dictionary links open through ordinary browser navigation and require no added dictionary host permission. The optional localhost permission is not required for any caption, highlighting, translation, or study feature. The recognition bridge address is accepted only when it resolves to loopback; the extension refuses remote hosts, URL credentials, paths, and query strings before sending a token or audio.

## Reporting a problem

Only share the information needed to reproduce an issue. Public video links are useful, but do not upload cookies, tokens, browser profiles, private video links, or screenshots containing personal information. [Open an issue](https://github.com/aolingge/yt-dual-subs/issues).

## 中文

本说明对应源码版本 **3.12.6**。扩展没有统计、广告代码、扩展账号或开发者运营的翻译服务器。YouTube、Google、浏览器和词典网站仍有各自的数据处理规则。

### 哪些内容会发送到外部

- **字幕加载：**向 YouTube 请求视频原文字幕轨及译文轨，使用播放器已有的字幕请求。
- **Bilibili 字幕：**读取当前视频/分 P 的字幕信息。仅 `api.bilibili.com` 请求携带页面会话凭据；HTTPS 白名单字幕 CDN 请求不携带凭据。
- **可选语音识别：**确认当前视频/分 P 没有字幕轨、且你明确启动后，当前标签页音频与认证令牌会发送到你配置的本机回环桥；扩展不会将这些音频发送至云端 ASR。
- **自动跟读时间：**原字幕缺少词时间时，可额外向 YouTube 请求同语言自动字幕，在本地匹配词时间。关闭逐词高亮后，新字幕请求不加载这条补充轨；近似跟读按音节、标点和本视频字幕实测语速在本地计算，本功能不采集、识别或上传音频。
- **整句翻译：**优先使用 YouTube；译文等待超过 0.35 秒或不可用时，Google 可收到当前句及后两句。
- **逐句翻译：**向 Google 发送字幕句子、已知的原文语言和目标语言。
- **快速显示：**立即并行使用 YouTube 和 Google；等待整轨译文时，Google 可收到当前句及后两句。
- **画面字幕预览：**完整原文轨尚未到达时，各模式都可能将播放器当前显示的原文发给 Google。
- **悬停查词：**停留约 0.4 秒后，向 Google 发送当前单词、已知的原文语言和目标语言；可单独关闭。
- **德语助手详查：**只有点击链接时，才通过词典网址向 `godic.net` 发送该词，悬停不会自动打开词典。
- **可选音频对齐：**由本机 `127.0.0.1` 上的辅助程序读取原文字幕和视频音频（或你选择的本地文件），不会发送到任何开发者服务器。某种语言首次分析时会从 Hugging Face 下载语音模型（约 360 MB），过程中不使用账号、令牌或 Cookie，也不会上传音频。只有你手动启动辅助程序并选择音频模式时才会运行。

Google 翻译使用 `translate.googleapis.com` 的**非官方免费端点**，可能不可用或被限流；扩展不要求或存储 API 密钥。网络请求通过浏览器正常发出，服务方可能收到 IP 地址等网络信息。可选的音频辅助程序是独立的本机程序：扩展不会安装、启动或更新它，除本机回环外不开放任何入站端口。

### 本地与同步存储

**设置**包括语言、样式、布局和学习设置，写入 `chrome.storage.sync`。尚未同步的修改及下次重试时间会暂存在 `chrome.storage.local` 的 `settingsPendingV1` 中，关闭弹窗或遇到同步限流时仍可使用。后台将同步写入合并，至少间隔 2.5 秒，并在活动时恢复待同步值。是否跨设备同步取决于浏览器的扩展同步设置；浏览器存储与 GitHub 仓库互相独立。

**桥接令牌**保存在扩展自身来源的 IndexedDB（`ytds-private` 的 `credentials`），不参与同步；视频页面内容脚本无法打开此扩展来源的数据库。只有后台处理令牌读写，并检查消息来源。后台启动时迁移旧同步、待同步或本地 `bridgeConfigV1` 中的令牌，提交成功后才清理旧副本；已有私有值（包括明确清空的空值）优先。页面设置与状态消息不携带令牌，服务地址仍可同步。这是来源隔离，并非加密或 Windows 凭据管理器；请保护浏览器资料目录。重置设置清除令牌，但保留收藏。

**收藏句子**保存在 `chrome.storage.local` 的 `studyCardsV1` 中，包含视频编号与标题、句子时间和序号、原文、可用译文、原文语言、掌握状态与收藏时间。收藏不会自动同步；字幕和翻译也可能使用临时内存缓存，减少重复请求。

**音频对齐结果**保存在 `chrome.storage.local` 的 `audioTimingCacheV1` 中，只保留最近几个视频、总大小有上限，键包含视频编号、语言、字幕轨哈希、模型与辅助程序版本、音频起始偏移，导入本地文件时还包括该文件的字节数与前 4 MiB 的哈希（用于区分不同录音，完全在本机计算，不是设备指纹）；辅助程序另在 `%LOCALAPPDATA%\YT Dual Subs\audio-alignment` 保存音频、模型和结果。删除其中任一处只会导致需要重新分析。

SRT、收藏 JSON 与 Anki TSV 下载到浏览器指定的位置，是否分享或通过其他工具同步由你决定。TSV 含句子、译文、视频编号与标题、时间链接和标签，不含桥接令牌。**卸载前请导出收藏备份。**导入会合并而不覆盖现有收藏；重置字幕设置不删除收藏，卸载则会清除扩展本地存储。

### 权限用途

- `storage`：保存设置和本地收藏。
- `tabCapture`、`offscreen`：用于明确启动的当前标签页识别，弹窗关闭后继续采集并保持声音可听。
- `https://translate.googleapis.com/*`：由后台请求句子与单词翻译。
- `https://www.youtube.com/*` 上的内容脚本：读取字幕、跟随播放时间、显示字幕框。页面主世界脚本观察字幕相关网络请求，以取得播放器的字幕地址。
- 可选 `127.0.0.1` 与 `localhost` 的 HTTP／HTTPS 主机权限：用于本机音频对齐与语音识别。对齐在开始分析时请求；识别在点击“检查连接”时只申请配置地址对应的主机。
- `https://www.bilibili.com/video/*` 上的内容脚本：读取当前视频/分 P 的字幕信息并显示双语字幕框。

扩展不申请所有网站、浏览历史、Cookie 或下载文件权限。词典链接通过普通网页跳转打开，不额外申请词典站点权限。可选的 localhost 权限对字幕、跟读、翻译和学习功能都不是必需的。语音识别桥地址只接受回环地址；发送令牌或音频前会拒绝远程主机、URL 凭据、路径和查询参数。

反馈问题时，请勿上传 Cookie、令牌、浏览器资料目录、私密视频链接或带个人信息的截图。[提交问题](https://github.com/aolingge/yt-dual-subs/issues)。

## 3.12.4 识别配置与内存音频

模型设置、术语及整句选项通过经过认证的本机回环接口传递，保存在桥进程内存，不写浏览器同步存储。网页内容脚本不能读取、修改这些配置或直接启动捕获/重试。桥最近片段缓存最多八段、六十秒，关闭会话或跳转后清理；不保存音频文件。校正仅留在当前视频页，用户主动收藏/导出后才持久保存文本。
