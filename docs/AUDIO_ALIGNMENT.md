# Audio-aligned highlighting / 音频对齐跟读

The optional audio workflow in source **3.11.0** fills missing word timestamps using the original captions and a local speech model. The ordinary bilingual-caption extension still works without Python, a model, or a local helper.

## 中文使用步骤

1. 更新后，在 `edge://extensions` / `chrome://extensions` 重新加载扩展，再刷新 YouTube 视频页。
2. 准备 **Python 3.10+、FFmpeg 和 Node.js**。FFmpeg 需在 PATH 中，或将环境变量 `YTDS_FFMPEG` 指向实际的 FFmpeg 可执行文件；Windows 下也识别 `%LOCALAPPDATA%\Programs\ffmpeg\ffmpeg.exe`。Node.js 用于公开 YouTube 音频的播放器脚本处理；选择本地文件不需要 Node.js。
3. 在扩展目录中双击 `tools/Start-AudioAlignment.cmd`。首次会在 `tools/audio-alignment/.venv` 准备 Python 依赖，新包安装在这个目录，已有 Torch 可以复用。程序只监听 `127.0.0.1:8765`，不会安装开机启动项，也不会自行常驻后台。
4. 打开带有原文字幕的 YouTube 视频，在插件弹窗的**词时间来源**中选择 **音频对齐**，再点击 **音频对齐跟读**，进入独立操作页。
5. 点击 **获取视频音频并对齐**。第一次连接会由浏览器询问本机站点访问权限；仅此功能需要该可选权限。
6. 首次分析会从 Hugging Face 下载所选语言的模型，约 360 MB。已有字幕词时间保持优先；缺少词时间的句子按当前观看位置、后续句子、前面句子的顺序分析。每批结果生成后会即时更新视频中的跟读，并缓存在本机。
7. YouTube 阻止匿名获取音频时，点击 **选择本地音频或视频**。文件须与当前视频一致、未经改变速度；若文件不是从 0:00 开始，请在 **本地音频的起始时间** 中填写它对应的视频时间（秒）。填写错误时程序不会静默套用：文件时长不足以覆盖字幕时会明确提示 `audioTooShort`，与字幕完全不相交时提示 `audioMismatch`，扩展页面在发送前也会先检查「起始时间 + 文件时长」是否覆盖到当前字幕末尾。音频不会上传到第三方。

播放不会自动等待分析。尚未分析到的句子沿用现有字幕词时间或近似跟读；想从头使用音频对齐，可等分析完成后回到开头。暂停、倍速和跳转都按视频时钟定位，词之间的停顿不保持音频高亮，可靠识别到的静音区间不会让上一个词一直亮着。保持分析页打开以接收进度与结果；完成后的结果会缓存，刷新视频时自动复用。缓存只在本机，不会写入跨设备偏好同步。

扩展弹窗的状态行会区分：**音频对齐处理中**、**音频对齐失败**（并提示先确认本机辅助程序在运行，然后重新对齐）、以及**结果已过期**（当前视频、字幕内容、语言或音频起始时间与已有结果不一致时，旧结果不会被套用，需要重新对齐）。切换视频或切换字幕后，正在进行的旧任务会被取消，旧结果不会覆盖新视频。

**目前支持德语和英语。** 模型结果存在误差，无法保证所有词准确。数字、模型不支持的字符、字幕与声音不一致、无声片段及低置信度句子会保持原有显示，不用插值伪造音频时间。此功能需要已有原文字幕，不负责无字幕视频的自动转写。

启动脚本也可在 PowerShell 中运行：

```powershell
.\tools\Start-AudioAlignment.ps1
# 查看运行中的输出，或单独准备依赖：
.\tools\Start-AudioAlignment.ps1 -Foreground
.\tools\Start-AudioAlignment.ps1 -SetupOnly
# 不使用时停止本机程序：
.\tools\Stop-AudioAlignment.ps1
```

程序、模型、音频及词时间默认保存在 `%LOCALAPPDATA%\YT Dual Subs\audio-alignment`。扩展中的结果缓存最多四个视频/语言记录，合并大小有上限。上述个人数据不进入仓库。需要节省磁盘时，可在停止程序后自行清理这个明确的缓存目录；清理后需重新分析。

**连不上本机程序时：** 先运行 `.\tools\Stop-AudioAlignment.ps1`（它会停止所有残留的本机程序进程），再重新启动 `Start-AudioAlignment.ps1`。程序在 `127.0.0.1:8765` 独占监听，第二个实例会直接退出并提示，不会像以前那样把请求分给两个进程；启动时会打印缓存目录以及是否可写，`/health` 也会返回同一路径。

## English

Install Python 3.10+, FFmpeg and, for anonymous YouTube downloads, Node.js. Run `tools/Start-AudioAlignment.ps1` (or double-click the Windows `.cmd`), reload the extension, refresh the captioned video, choose **Audio alignment** as the word-time source in the popup, then open **Audio-aligned highlighting**. The analysis page requests optional access to `http://127.0.0.1/*` only when starting a job. Choose anonymous audio download or a matching local media file.

A local file must belong to the same video and must not be speed-changed. If it does not start at 0:00, enter the video time it starts at in **Start time of the local file**; a wrong value is refused rather than silently applied — the helper reports `audioTooShort` when the file cannot cover the subtitles and `audioMismatch` when it does not overlap them at all, and the page also checks that the entered start time plus the file duration reaches the end of the loaded captions before sending.

German and English models run on the CPU. First use downloads about 360 MB per language; inference speed depends on the computer. Captions remain readable while analysis runs, and partial results update the existing renderer. Native and matched automatic-caption word times keep priority. Unreliable alignments retain the existing mode. This does not create transcripts for videos without captions or promise error-free word boundaries.

**Troubleshooting.** If the analysis page reports that it cannot reach the local helper, run `tools/Stop-AudioAlignment.ps1` (it stops every leftover helper process) and start `Start-AudioAlignment.ps1` again. The helper binds `127.0.0.1:8765` exclusively, so a second copy exits with a message instead of splitting requests between two processes; the launcher prints the cache directory and whether it is writable, and `GET /health` reports the same path. Restart the helper after updating the extension: results carry the version of the helper that produced them, and an older helper cannot produce the sentence-locked format this build applies, so the analysis page refuses to start and says the helper is too old instead of running the model and discarding the result. The popup's status line distinguishes running, failed, and stale results; a result is stale when the current video, caption text, language, model or audio start time no longer matches it, and it is never applied.

## Implementation and verification

- `alignment.html`, `alignment.js`, `alignment.css`: dedicated extension page, optional permission, progress, local-file upload with a start-time field, cancellation, and delivery to the original video tab. Closing the page marks the analysis as failed instead of leaving the popup claiming it is still running.
- `tools/audio-alignment/server.py`: loopback-only HTTP jobs; anonymous audio download; FFmpeg mono 16 kHz decoding; Transformers Wav2Vec2 character probabilities; CTC Viterbi alignment with repeated-letter blank constraints; confidence rejection; incremental word starts/ends and disk cache. A caption is aligned only inside its own window in audio time, so a word can neither be counted twice nor borrowed from a neighbouring caption. Every sentence states its position in the subtitle track and gets that position back, so a re-ordered or re-segmented track cannot receive times measured for another sentence.
- `word-timing.js` / `word-timing-page.js`: exact original-text/window validation, native timing priority, partial matching against the automatic track, and the local pace estimate. A result is applied only to the sentence position it was measured at, and one result format version is accepted at a time, so a record written by an older algorithm is ignored rather than mixed into the display. Audio metadata applies only to display groups; raw captions and SRT exports stay intact.
- `audio-cache.js`: serialized, bounded local timing cache, independent of preference sync writes. A record is identified by video id, source language, a hash of the caption track (text, boundaries and order), the model and helper version, the audio start offset, and — for an imported file — the file's own identity: its byte size and the SHA-256 of its first 4 MiB, which the helper recomputes from the bytes it receives. Replacing the file therefore produces a new result instead of reusing word times measured on the previous recording, and only a result the helper marked complete is treated as a cache hit. Video/source-language/text/window checks prevent delayed results from applying to another video or track.
- The helper accepts browser origins only from extension pages, rejects remote website origins and unexpected Host headers, accepts only fixed YouTube video IDs for downloads, and has no API to read arbitrary local paths. Local files are explicitly selected and sent to the loopback helper. No cookies or access tokens are loaded; model downloads use `token=False` and `trust_remote_code=False` with Safetensors weights.
- `tests/test_audio_alignment.py` (14 tests) covers the CTC repeated-letter/blank constraints, weak-alignment rejection, request validation, sentence-position validation and echo, job cache keys (including the audio identity), reuse of only a complete result for the same audio, local-audio start-offset and coverage validation (`audioTooShort`, `audioMismatch`), trimmed-file windowing and the adjacent-caption window invariant, loopback Origin/Host/JSON rejection, the `/health` cache-directory and model report, and the exclusive port bind that keeps two helpers from splitting one job between them.

Run the Node suite as documented in [DEVELOPMENT.md](DEVELOPMENT.md), and the optional helper checks with:

```powershell
.\tools\audio-alignment\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_audio_alignment.py"
```

### What has actually been verified

Verified on this machine with the real helper process and the real German model (`oliverguhr/wav2vec2-base-german-cv9`, loaded through the helper's own `Aligner.load`):

- The helper starts, answers `GET /health`, reports the cache directory and the model identity, and refuses a second instance on the same port.
- The German model loads through the helper's own code path (first load 67.5 s with a cold model cache, 13.4 s warm) and aligns 78 of 78 words across 12 real German recordings from the public-domain Thorsten corpus, with a strictly increasing word order inside every caption window and per-word CTC scores of 0.89–1.00.
- The aligned span sits inside the recording: the first word starts 80–303 ms (median 261 ms) after the audio begins and the last word ends 304 ms (median) before it; the aligned span covers 49–96% of the recording, and the strongest compression appears on captions shorter than about 2 s. Treat word boundaries as an aid, not as measured speech onset.
- Discrimination: with the same words in a shuffled order, 8 of 9 captions were rejected rather than given believable times.
- Alignment cost: 97–453 ms per caption (median 198 ms) on this CPU-only machine.
- The whole extension-side path was then exercised against the **real helper process** (started as a normal subprocess, its own `/health` handshake) with a real local audio file: the extension's version check accepted helper version 2, all three sentences came back with the position they were sent at (`segments [0, 1, 2]`), the cache entry was written as complete and bound to the file's own identity (`local:1366444-9a11068d0c6a1909`, size plus the SHA-256 of the first 4 MiB), the same file and captions reused that entry without uploading the audio again, a file that was not the declared audio was refused with `audioMismatch`, and the same file at a different start offset produced a different result instead of a cache hit.
- The same twelve captions were re-aligned with the extension's own tokenizer after the round-2 changes: all 78 words reproduced the earlier run's starts and ends exactly (0.0 ms), so the position lock, the record version and the cache-identity work did not move a single model boundary. One apparent 1.1 s deviation in an earlier harness run turned out to be the harness splitting on whitespace while the extension's tokenizer splits a hyphenated compound — production sends the extension's own tokens to the helper, so both sides always agree on word granularity.

**Not verified.** Absolute per-word error against human-checked word boundaries was not measured — these recordings have one human-written transcript per clip, not word-level ground truth, so the numbers above show internal consistency, coverage and bias, not accuracy. Only one speaker was covered (no multi-speaker case), and the audio itself could not be fetched from YouTube in this environment: the local proxy truncated every media stream (`Unable to connect to proxy` / `Stream ends prematurely`), and YouTube later answered `Sign in to confirm you're not a bot` for the anonymous download path, so the live download route was exercised only up to its failure handling. Do not read this section as a claim that word timing is accurate on arbitrary videos.

Models: [German base CV9 (MIT)](https://huggingface.co/oliverguhr/wav2vec2-base-german-cv9), fixed revision `e3c2cb317c771e7fbbdfbf20be6017b8e65b232d`; [English Wav2Vec2 base 960h (Apache 2.0)](https://huggingface.co/facebook/wav2vec2-base-960h). The German model is loaded through explicit extractor/tokenizer/CTC classes, avoiding its optional language-model decoder. CTC algorithm reference: [PyTorch forced alignment tutorial](https://docs.pytorch.org/audio/main/tutorials/forced_alignment_tutorial.html). Download tool: [yt-dlp](https://github.com/yt-dlp/yt-dlp). The verification corpus is [Thorsten-Voice TV-24kHz-Neutral](https://huggingface.co/datasets/Thorsten-Voice/TV-24kHz-Neutral) (public-domain German speech). These are third-party dependencies, not developer-operated services.
