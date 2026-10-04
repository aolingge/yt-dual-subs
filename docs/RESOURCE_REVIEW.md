# Ressourcenvergleich / 资源比较

Geprüft am 2026-10-04 anhand der verlinkten Primärquellen und des lokalen Codes. Die Tabelle deckt Erkennung, Zeitabgleich, Übersetzung, Wörterbücher, Lernabläufe und Messdaten ab. Die Bewertungen sind Entscheidungen für dieses Projekt, keine unabhängigen Qualitätsranglisten.

核对日期：2026-10-04，依据下列官方来源和本地代码。覆盖识别、时间对齐、翻译、词典、学习流程及测试数据。评价是本项目的选择依据，不是独立的质量排行榜。

| Ressource / 资源 | Nutzen / 用途 | Aufwand und Grenze / 工作量与限制 | Entscheidung / 决定 |
| --- | --- | --- | --- |
| [OpenCC](https://github.com/BYVoid/OpenCC) | Einheitliche chinesische Schrift / 中文简繁一致 | Apache-2.0; keine Korrektur von Hörfehlern / 不能修复听辨错误 | In der Quell-Bridge integriert; Rohtext und sichere Wortzuordnung erhalten / 源码桥已整合，保留原始文本及可靠词时间对应 |
| [faster-whisper Hotwords](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py) | Namen und Fachbegriffe / 名称及术语 | MIT; Hinweise können falsche Einfügungen begünstigen / 提示可能诱发错误插入 | Optionale lokale Sprachlisten, standardmäßig leer / 可选本地分语言词表，默认空 |
| [Silero VAD](https://github.com/snakers4/silero-vad) | Sprachclips vor Erkennung bilden / 识别前生成语音片段 | MIT; vorhandenes ONNX-Modell; leise Sprache prüfen / 已有 ONNX 模型，需测轻声 | Im Bridge-CLI vor der Segmentierung aktiviert; Energy-Vergleich bleibt wählbar / 源码桥启动入口已启用，保留音量阈值比较选项 |
| [Whisper Turbo](https://huggingface.co/openai/whisper-large-v3-turbo), [CTranslate2-Konvertierung](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo) | Weiteres Modell für de/en/zh / 德英中另一模型 | MIT; größere Modell-Datei und Hardwarebedarf; keine Garantie pro Clip / 模型更大，需实测，单段不保证更准确 | Lokale Modellwahl implementiert; feste Revision und SHA256 für Vergleich / 已实现本地模型选择，用固定版本和哈希比较 |
| [WhisperX](https://github.com/m-bain/whisperX) | Phonetische Wortausrichtung / 音素级词对齐 | BSD-2-Clause-Code; zusätzliche sprachabhängige Modelle; Zahlen/überlappende Stimmen schwierig / 额外语言模型，数字及重叠语音有局限 | Kandidat für separat gemessene Wortgrenzen / 列为需独立测量词边界的候选 |
| [Qwen3-ASR / ForcedAligner](https://github.com/QwenLM/Qwen3-ASR) | ASR und Ausrichtung, auch Deutsch / 识别及对齐，含德语 | Apache-2.0-Code; zusätzliche Modell-/Runtimeprüfung, keine lokale Messung / 需核对模型及运行库，本机尚未实测 | Weiterer Modellvergleich; keine Aktivierung / 列入模型比较，未启用 |
| [SenseVoice / FunASR](https://github.com/QwenAudio/SenseVoice), [Modellkarte](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | Chinesischer Erkennungskandidat / 中文识别候选 | Code MIT; Gewichte mit eigener Lizenz; Small deckt Deutsch nicht ab / 权重单独许可，Small 不覆盖德语 | Spezialkandidat, kein allgemeiner Ersatz / 专项候选，不作为统一替代 |
| [OPUS zh→de](https://huggingface.co/Helsinki-NLP/opus-mt-zh-de) | Lokale deutsche Übersetzung / 本地译为德语 | Apache-2.0-Modell; Fachtexte brauchen Referenzen / 专业内容需参考验证 | Bestehenden Übersetzer wiederverwenden / 复用已有译者 |
| [Argos Translate](https://github.com/argosopentech/argos-translate) | Offline-Sprachpakete / 离线语言包 | MIT/CC0-Code; Zwischenübersetzung kann Qualität kosten / 中转翻译可能损失质量 | Kein belegter Vorteil gegenüber installierten OPUS-Modellen / 尚无优于已有 OPUS 的证据 |
| [LibreTranslate](https://docs.libretranslate.com/guides/api_usage/) | Konfigurierbare Übersetzungs-API / 可配置翻译接口 | Eigene Instanz/Sprachpakete oder fremder Dienst nötig / 需要实例及语言包或外部服务 | Kandidat für späteren Provider, keine neue Dauerinstanz / 后续翻译提供方候选，未新增常驻实例 |
| [DeepL API](https://developers.deepl.com/api-reference/translate/request-translation) | Kontext und Glossar / 上下文及术语表 | Konto/Schlüssel, Tarif und Datentransfer; separat einzurichten / 账号、密钥、套餐及外传需另配置 | Optionaler offizieller Provider; nicht aktiviert / 可选官方接口，未启用 |
| [Cloud Translation](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate) | Offizielle Google-Schnittstelle / 官方 Google 接口 | Credentials und Abrechnung; freier vorhandener Endpoint bleibt inoffiziell / 凭据及计费，现有免费端点仍属非官方 | Provider-Kandidat; nicht aktiviert / 翻译提供方候选，未启用 |
| [asbplayer](https://github.com/asbplayer/asbplayer) | Satznavigation, Anki, Medienkarten / 句子跳转、Anki、媒体卡片 | AGPL-3.0-or-later-Hauptlizenz; Interoperabilität bevorzugen / 主要许可为 AGPL，优先互操作 | Transkript und Auto-Pause bereits vorhanden; Audio-Mining gesondert prüfen / 已有字幕列表及自动暂停，音频制卡需单独核对 |
| [Yomitan](https://github.com/yomidevs/yomitan) | Wörterbuch-Popups / 词典弹窗 | GPL-3.0; Wörterbuchdaten separat; deutsche Abdeckung ungeprüft / 词典另有许可，德语覆盖待测 | Auswählbaren Text verwenden; kein kopierter GPL-Code / 使用可选文本，未复制 GPL 代码 |
| [Trancy](https://www.trancy.org/), [Immersive Translate](https://immersivetranslate.com/docs/usage/) | Lesemodus, Grammatik, Plattformen und Untertiteldateien / 阅读模式、语法、多平台及字幕文件 | Fertige Produkte, kein behauptetes offenes Integrations-API / 成熟产品，不宣称存在开放整合接口 | Referenz für Bedienung; keine stille Installation / 借鉴操作体验，未静默安装 |
| [Anki-Import](https://docs.ankiweb.net/importing/text-files.html) | UTF-8 TSV und Medienreferenzen / UTF-8 TSV 及媒体引用 | Echte Importprüfung braucht installierte App / 实际导入需已安装应用 | Vorhandenen TSV-Export nutzen / 使用已有 TSV 导出 |
| [Google FLEURS](https://huggingface.co/datasets/google/fleurs) | Menschliche Referenzsprache / 真人语音参考 | CC-BY-4.0; saubere gelesene Sprache deckt Musik/Alltag nicht ab / 清晰朗读不代表音乐及日常场景 | Feste Revision, keine Auswahl nach Ergebnis; Roh- und Schriftmetriken getrennt / 固定版本，不按结果选样，分开原始与简繁指标 |

## Umsetzung / 实施

Die hier dokumentierte Recherche und Modellmessung gehört zur Runde mit Version 3.12.2. Die aktuelle Erweiterung ist 3.12.6; spätere Änderungen stehen in den Versionsnotizen. Die neue Bridge muss aus der aktualisierten Quelle neu gestartet werden; ein altes installiertes EXE erhält diese Änderungen nicht automatisch.

这里记录的资源研究和模型测量对应 3.12.2 阶段。当前扩展为 3.12.6，后续修改见版本说明。需要从更新源码重新启动识别桥，旧的已安装 EXE 不会自动获得这些改进。

Der Bridge-CLI bietet `--chinese-script simplified|traditional|raw`, `--asr-model-path`, `--hotwords-file` und `--speech-gate silero|energy`. Fachwörter werden nur bei explizit gesetzter oder bestätigter Sprache benutzt. Eine automatische Spracherkennung bekommt keine gemischte Liste. Die Listen gelten für die bewusst konfigurierte Bridge-Laufzeit, nicht als automatisch aus dem Videotitel abgeleitete Wahrheit.

桥启动入口提供上述参数。术语仅用于明确指定或已确认的语言，自动初探不混入跨语言词表。词表作用于主动配置的桥运行周期，不自动把视频标题当成正确答案。

`rawText` im Datei-JSON und `rawOriginal` im Bridge-Protokoll erhalten die Ausgabe des Modells vor OpenCC. Wortzeiten bleiben nur erhalten, wenn die einzeln konvertierten Wörter den vollständigen konvertierten Satz ergeben; sonst werden sie entfernt. OpenCC ist keine neue akustische Erkennung.

文件 JSON 的 `rawText` 和桥协议的 `rawOriginal` 保留 OpenCC 前的模型文本。只有逐词转换仍能完整对应转换后句子时才保留词时间，否则清除。OpenCC 不是新的听辨算法。

Die `absent`-Schranke bleibt verbindlich: ASR einer Videoseite darf nur nach zuverlässig bestätigtem Fehlen lesbarer nativer Untertitel starten. Unklare Zustände und Fehler berechtigen nicht zum Erkennen.

视频页的 `absent` 门槛继续有效：仅在可靠确认没有可读原生字幕后启动识别；不明确状态和错误不允许启动。

## Modellvergleich / 模型比较

30 unabhängige FLEURS-Testaufnahmen, die ersten zehn passenden Archiveinträge je Sprache, bei zwei wiederholten Eingaberaten. Beide Modelle: RTX 5060 Laptop GPU, int8_float16, Beam 3, gleiche vereinfachte chinesische Schrift, leere Fachwortliste. Summen schließen die wiederholten Raten ein und sind keine 60 unabhängigen Aufnahmen.

30 段独立 FLEURS 测试录音，每种语言取归档中最先匹配的十段，各重复两个输入率。两个模型均使用 RTX 5060 Laptop GPU、int8_float16、beam 3、同样的简体规则和空术语表。总数包含输入率重复，不能称为 60 段独立录音。

| Sprache / 语言 | Small | Turbo |
| --- | ---: | ---: |
| Deutsch WER / 德语词错误率 | 35/490 = 7.14% | 16/490 = 3.27% |
| Englisch WER / 英语词错误率 | 29/424 = 6.84% | 20/424 = 4.72% |
| Mandarin CER / 普通话字符错误率 | 107/734 = 14.58% | 62/734 = 8.45% |

Turbo verschlechterte einen der chinesischen Einzelvergleiche. Die rohe chinesische Small-CER vor OpenCC war 123/734; der Modellvergleich verwendet für beide dieselbe Schriftregel. Das belegt einen Vorteil in dieser Stichprobe sauberer Lesesprache, keinen universellen Gewinn bei Musik, Akzenten oder Live-Capture. Die Standardwahl bleibt Small; die lokale Qualitätsoption wählt Turbo ausdrücklich.

Turbo 的一个中文单项比较变差。Small 在 OpenCC 前的原始中文错误数为 123/734；模型比较对双方使用相同字形规则。这证明在这组清晰朗读样本中有收益，不能保证音乐、口音或实时采集也普遍改善。默认模型保留 Small，本地高质量入口明确选择 Turbo。

Der frühe Silero-Detector erzeugte Sprachclips für 30/30 normale und 30/30 leiser gerechnete Dateien; die alte Energieschwelle für 24/30 und 17/30. Stille, 440-Hz-Ton und weißes Rauschen erzeugten mit Silero keine Clips. Clip-Annahme misst keine vollständigen Wortgrenzen. 276 Python-Tests bestanden, 11 wurden übersprungen; alle neuen Audiomessungen liefen ohne Wiedergabe.

提前加入的 Silero 在正常及降音量文件中均保留 30/30 段，旧音量阈值分别为 24/30 和 17/30。静音、440 Hz 纯音和白噪声在 Silero 下不产生片段。片段接收不代表词边界全部准确。Python 测试 276 项通过、11 项跳过，新增音频测量全部不播放。
