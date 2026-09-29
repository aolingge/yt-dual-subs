# Audio-aligned highlighting / 音频对齐跟读

The optional audio workflow in source **3.10.0** fills missing word timestamps using the original captions and a local speech model. The ordinary bilingual-caption extension still works without Python, a model, or a local helper.

## 中文使用步骤

1. 更新后，在 `edge://extensions` / `chrome://extensions` 重新加载扩展，再刷新 YouTube 视频页。
2. 准备 **Python 3.10+、FFmpeg 和 Node.js**。FFmpeg 需在 PATH 中，或将环境变量 `YTDS_FFMPEG` 指向实际的 FFmpeg 可执行文件；Windows 下也识别 `%LOCALAPPDATA%\Programs\ffmpeg\ffmpeg.exe`。Node.js 用于公开 YouTube 音频的播放器脚本处理；选择本地文件不需要 Node.js。
3. 在扩展目录中双击 `tools/Start-AudioAlignment.cmd`。首次会在 `tools/audio-alignment/.venv` 准备 Python 依赖，新包安装在这个目录，已有 Torch 可以复用。程序只监听 `127.0.0.1:8765`，不会安装开机启动项。
4. 打开带有原文字幕的 YouTube 视频，在插件弹窗中点击 **音频对齐跟读**，进入独立操作页。
5. 点击 **获取视频音频并对齐**。第一次连接会由浏览器询问本机站点访问权限；仅此功能需要该可选权限。
6. 首次分析会从 Hugging Face 下载所选语言的模型，约 360 MB。已有字幕词时间保持优先；缺少词时间的句子按当前观看位置、后续句子、前面句子的顺序分析。每批结果生成后会即时更新视频中的跟读，并缓存在本机。
7. YouTube 阻止匿名获取音频时，点击 **选择本地音频或视频**。文件须与当前视频一致，从视频的 **0:00** 开始，未经剪头或改变速度，最大 512 MiB。音频不会上传到第三方。

播放不会自动等待分析。尚未分析到的句子沿用现有字幕词时间或近似跟读；想从头使用音频对齐，可等分析完成后回到开头。暂停、倍速和跳转都按视频时钟定位，词之间的停顿不保持音频高亮。保持分析页打开以接收进度与结果；完成后的结果会缓存，刷新视频时自动复用。缓存只在本机，不会写入跨设备偏好同步。

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

Install Python 3.10+, FFmpeg and, for anonymous YouTube downloads, Node.js. Run `tools/Start-AudioAlignment.ps1` (or double-click the Windows `.cmd`), reload the extension, refresh the captioned video, and choose **Audio-aligned highlighting** in the popup. The analysis page requests optional access to `http://127.0.0.1/*` only when starting a job. Choose anonymous audio download or a matching local media file beginning at video time zero.

German and English models run on the CPU. First use downloads about 360 MB per language; inference speed depends on the computer. Captions remain readable while analysis runs, and partial results update the existing renderer. Native and matched automatic-caption word times keep priority. Unreliable alignments retain the existing mode. This does not create transcripts for videos without captions or promise error-free word boundaries.

**Troubleshooting.** If the analysis page reports that it cannot reach the local helper, run `tools/Stop-AudioAlignment.ps1` (it stops every leftover helper process) and start `Start-AudioAlignment.ps1` again. The helper binds `127.0.0.1:8765` exclusively, so a second copy exits with a message instead of splitting requests between two processes; the launcher prints the cache directory and whether it is writable, and `GET /health` reports the same path.

## Implementation and verification

- `alignment.html`, `alignment.js`, `alignment.css`: dedicated extension page, optional permission, progress, file upload, cancellation and delivery to the original video tab.
- `tools/audio-alignment/server.py`: loopback-only HTTP jobs; anonymous audio download; FFmpeg mono 16 kHz decoding; Transformers Wav2Vec2 character probabilities; CTC Viterbi alignment with repeated-letter blank constraints; confidence rejection; incremental word starts/ends and disk cache.
- `word-timing.js` / `word-timing-page.js`: exact original-text/window validation and native timing priority. Audio metadata applies only to display groups; raw captions and SRT exports stay intact.
- `audio-cache.js`: serialized, bounded local timing cache, independent of preference sync writes. Video/source-language/text/time-window checks prevent delayed results from applying to another video or track.
- The helper accepts browser origins only from extension pages, rejects remote website origins and unexpected Host headers, accepts only fixed YouTube video IDs for downloads, and has no API to read arbitrary local paths. Local files are explicitly selected and sent to the loopback helper. No cookies or access tokens are loaded; model downloads use `token=False` and `trust_remote_code=False` with Safetensors weights.
- `tests/test_audio_alignment.py` (7 tests) covers the CTC repeated-letter/blank constraints, weak-alignment rejection, request validation, cache keys and cancellation, loopback Origin/Host/JSON rejection, the `/health` cache-directory report, and the exclusive port bind that keeps two helpers from splitting one job between them.

Run the Node suite as documented in [DEVELOPMENT.md](DEVELOPMENT.md), and the optional helper checks with:

```powershell
.\tools\audio-alignment\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_audio_alignment.py"
```

Models: [German base CV9 (MIT)](https://huggingface.co/oliverguhr/wav2vec2-base-german-cv9), fixed revision `e3c2cb317c771e7fbbdfbf20be6017b8e65b232d`; [English Wav2Vec2 base 960h (Apache 2.0)](https://huggingface.co/facebook/wav2vec2-base-960h). The German model is loaded through explicit extractor/tokenizer/CTC classes, avoiding its optional language-model decoder. CTC algorithm reference: [PyTorch forced alignment tutorial](https://docs.pytorch.org/audio/main/tutorials/forced_alignment_tutorial.html). Download tool: [yt-dlp](https://github.com/yt-dlp/yt-dlp). These are third-party dependencies, not developer-operated services.
