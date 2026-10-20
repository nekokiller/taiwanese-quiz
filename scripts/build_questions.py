"""由試卷抄錄與音檔對照表產生測驗題庫 data/questions.json 與盤點表 docs/audio-inventory.md。

- data/exam.csv：試卷照片逐題抄錄（全部 200 題），是題目的依據。
- 音檔對照表.csv：一列是一段錄音，依（類型, 題號）對應到題目。

補上新音檔後只要更新對照表再重跑即可；兩份資料的考字或讀音不一致時會印出警告。

用法：python scripts/build_questions.py
"""
import csv
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAM_CSV = ROOT / "data" / "exam.csv"
AUDIO_CSV = ROOT / "taiwanese-pronunciation-200-mp3" / "音檔對照表.csv"
QUESTIONS_OUT = ROOT / "data" / "questions.json"
INVENTORY_OUT = ROOT / "docs" / "audio-inventory.md"

SECTION_PREFIX = {"字音": "A", "字形": "B"}


def nfc(s):
    return unicodedata.normalize("NFC", s.strip())


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def split_alts(s):
    """'sū/sīr/sī/sǐr' -> ['sū', 'sīr', 'sī', 'sǐr']"""
    return [x for x in (p.strip() for p in nfc(s).split("/")) if x]


def parse_dict_romanization(s):
    """'（白）kǹg' -> ('白', ['kǹg'])；'tó-sū/tóo-sū' -> (None, ['tó-sū', 'tóo-sū'])"""
    s = nfc(s)
    m = re.match(r"^（(.)）", s)
    register = m.group(1) if m else None
    if m:
        s = s[m.end():]
    return register, split_alts(s)


def syllables(romanizations):
    return {
        x.lower()
        for r in romanizations
        for x in re.split(r"[-\s]+", r)
        if x
    }


def split_prompt(face):
    """'疊（thia̍p tsng/tsuinn-á）' -> ('疊', 'thia̍p tsng/tsuinn-á')"""
    m = re.match(r"^(.*?)（(.*)）$", face)
    return (m.group(1), m.group(2)) if m else (face, None)


def build():
    exam = read_csv(EXAM_CSV)
    clips = defaultdict(list)
    for r in read_csv(AUDIO_CSV):
        clips[(r["類型"], int(r["題號"]))].append(r)

    questions = []
    for e in exam:
        section, no = e["類型"], int(e["題號"])
        paper = nfc(e["題面"])
        target = nfc(e["考字"])
        readings = split_alts(e["臺羅"])
        rs = clips.pop((section, no), [])

        if rs and (nfc(rs[0]["考字"]) != target or split_alts(rs[0]["試卷單字臺羅"]) != readings):
            print(f"警告：{section} {no} 試卷抄錄（{target} {'/'.join(readings)}）"
                  f"與音檔對照表（{rs[0]['考字']} {rs[0]['試卷單字臺羅']}）不一致")

        # 字音題的漢字詞就是題面；字形題試卷只有臺羅，漢字詞取自音檔對照表依辭典還原的詞
        if section == "字音":
            prompt, prompt_note = paper.replace("「", "").replace("」", ""), None
        elif rs:
            prompt, prompt_note = split_prompt(nfc(rs[0]["題面或對照詞"]))
            # 附註以試卷臺羅為準（對照表字形 3 題誤植為 tè-àm，試卷是 tè-ám）
            if prompt_note:
                prompt_note = paper.replace("「", "").replace("」", "")
        else:
            prompt, prompt_note = None, None

        audio = []
        for r in rs:
            register, roman = parse_dict_romanization(r["辭典臺羅"])
            audio.append({
                "kind": r["錄音類型"],
                "word": nfc(r["音檔詞目"]),
                "romanization": roman,
                "register": register,
                "file": Path(r["離線音檔"]).name,
                "url": r["MP3網址"],
                "entryUrl": r["教育部詞目"],
            })

        # 整詞錄音須含試卷讀音才能當標準音（例：字形 74「擔頭」錄音為 tànn，試卷要 tann）
        word_clip = next(
            (a for a in audio
             if a["kind"] == "整詞讀音" and a["word"] == prompt
             and syllables(a["romanization"]) & {x.lower() for x in readings}),
            None,
        )
        char_clips = [a for a in audio if a["kind"] == "單字本調"]
        # 使用者唸整個詞；沒有整詞錄音時，改唸同字參考詞或單字
        reference = (
            word_clip
            or next((a for a in audio if a["kind"] == "同字參考詞"), None)
            or (char_clips[0] if char_clips else None)
        )

        covered = syllables(r for a in audio for r in a["romanization"])
        questions.append({
            "id": f"{SECTION_PREFIX[section]}{no:03d}",
            "section": section,
            "no": no,
            "paper": paper,
            "prompt": prompt,
            "promptNote": prompt_note,
            "target": target,
            "readings": readings,
            "uncertain": e["待確認"].strip() or None,
            "speak": reference["word"] if reference else None,
            "speakRomanization": reference["romanization"] if reference else [],
            "reference": reference["file"] if reference else None,
            "audio": audio,
            "gaps": {
                "noAudio": not audio,
                "wordAudio": word_clip is None,
                "charAudio": not char_clips,
                "readings": [x for x in readings if x.lower() not in covered],
            },
        })

    for (section, no) in clips:
        print(f"警告：音檔對照表有 {section} {no}，但試卷抄錄沒有這題")

    return {
        "source": {
            "exam": "信義國小115學年度語文競賽—臺灣台語字音字形（題目引自113年全國語文競賽【國小組】）",
            "audio": "教育部《臺灣台語常用詞辭典》 https://sutian.moe.edu.tw/",
        },
        "audioBase": "taiwanese-pronunciation-200-mp3/mp3/",
        "questions": questions,
    }


def mark(prompt, target):
    i = prompt.find(target)
    return prompt if i < 0 else f"{prompt[:i]}「{target}」{prompt[i + len(target):]}"


def inventory_markdown(data):
    qs = data["questions"]
    yes = lambda b: "✓" if b else "—"
    lines = [
        "# 考題語音檔盤點",
        "",
        "> 本檔由 `scripts/build_questions.py` 產生，請勿手動修改。",
        "",
        "試題：" + data["source"]["exam"] + "，共 6 頁，照片在 [reference/](reference/)。",
        "",
        "## 總覽",
        "",
        "| 部分 | 試卷題數 | 有評分標準音 | 完全沒有錄音 | 可照題面唸 | 有單字錄音 | 腔調齊全 | 字待確認 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for section in SECTION_PREFIX:
        s = [q for q in qs if q["section"] == section]
        has = [q for q in s if q["reference"]]
        lines.append(
            f"| {section} | {len(s)} | {len(has)} | {len(s) - len(has)} "
            f"| {sum(not q['gaps']['wordAudio'] for q in has)} "
            f"| {sum(not q['gaps']['charAudio'] for q in has)} "
            f"| {sum(not q['gaps']['readings'] for q in has)} "
            f"| {sum(bool(q['uncertain']) for q in s)} |"
        )
    lines += [
        "",
        "「可照題面唸」「有單字錄音」「腔調齊全」只計算有錄音的題目。",
        "",
    ]

    uncertain = [q for q in qs if q["uncertain"]]
    if uncertain:
        lines += ["## 待確認的字", "", "| 題目 | 試卷題面 | 抄錄 | 說明 |", "|---|---|---|---|"]
        lines += [f"| {q['section']} {q['no']} | {q['paper']} | {q['target']} | {q['uncertain']} |"
                  for q in uncertain]
        lines.append("")

    lines += [
        "## 逐題明細",
        "",
        "「要唸」與題面不同時，表示該題缺題面整詞錄音（或錄音讀音與試卷不符），改唸單字或參考詞。",
        "",
    ]
    for section in SECTION_PREFIX:
        lines += [
            f"### {section}",
            "",
            "| 題號 | 試卷題面 | 考字 | 試卷讀音 | 要唸（標準音） | 整詞 | 單字 | 缺錄音的腔調 |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for q in qs:
            if q["section"] != section:
                continue
            if not q["reference"]:
                lines.append(f"| {q['no']} | {q['paper']} | {q['target']} | {'/'.join(q['readings'])} "
                             f"| **無錄音** | — | — | |")
                continue
            face = mark(q["prompt"], q["target"])
            if q["promptNote"]:
                face += f"（{q['promptNote']}）"
            speak = q["speak"] if q["speak"] != q["prompt"] else face
            lines.append(
                f"| {q['no']} | {q['paper']} | {q['target']} | {'/'.join(q['readings'])} "
                f"| {speak}（{'/'.join(q['speakRomanization'])}） "
                f"| {yes(not q['gaps']['wordAudio'])} | {yes(not q['gaps']['charAudio'])} "
                f"| {'/'.join(q['gaps']['readings'])} |"
            )
        lines.append("")
    return "\n".join(lines)


def main():
    data = build()
    QUESTIONS_OUT.parent.mkdir(parents=True, exist_ok=True)
    QUESTIONS_OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    INVENTORY_OUT.write_text(inventory_markdown(data), encoding="utf-8")

    qs = data["questions"]
    with_audio = [q for q in qs if q["reference"]]
    print(f"{len(qs)} 題（有錄音 {len(with_audio)} 題） -> {QUESTIONS_OUT}")
    print("無錄音:", " ".join(q["id"] for q in qs if not q["reference"]))
    print("缺整詞錄音:", " ".join(q["id"] for q in with_audio if q["gaps"]["wordAudio"]))
    print("缺單字錄音:", sum(q["gaps"]["charAudio"] for q in with_audio), "題")
    print("缺腔調錄音:", " ".join(f'{q["id"]}({"/".join(q["gaps"]["readings"])})'
                             for q in with_audio if q["gaps"]["readings"]))
    print("字待確認:", " ".join(q["id"] for q in qs if q["uncertain"]))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
