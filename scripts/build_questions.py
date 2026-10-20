"""由「音檔對照表.csv」產生測驗題庫 data/questions.json。

CSV 一列是一段錄音；本腳本依（類型, 題號）合併成一題，並標出缺少的錄音，
補上新音檔後只要更新 CSV 再重跑即可。

用法：python scripts/build_questions.py [CSV 路徑] [輸出路徑]
"""
import csv
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = ROOT / "taiwanese-pronunciation-130-mp3" / "音檔對照表.csv"
DEFAULT_OUT = ROOT / "data" / "questions.json"

SECTION_PREFIX = {"字音": "A", "字形": "B"}


def nfc(s):
    return unicodedata.normalize("NFC", s.strip())


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


def build(csv_path):
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    groups = defaultdict(list)
    for r in rows:
        groups[(r["類型"], int(r["題號"]))].append(r)

    questions = []
    for (section, no), rs in sorted(
        groups.items(), key=lambda kv: (SECTION_PREFIX[kv[0][0]], kv[0][1])
    ):
        first = rs[0]
        prompt, prompt_note = split_prompt(nfc(first["題面或對照詞"]))
        target = nfc(first["考字"])
        readings = split_alts(first["試卷單字臺羅"])

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

        word_clip = next(
            (a for a in audio if a["kind"] == "整詞讀音" and a["word"] == prompt), None
        )
        char_clips = [a for a in audio if a["kind"] == "單字本調"]
        # 使用者唸整個詞；沒有整詞錄音時，改唸同字參考詞或單字
        reference = (
            word_clip
            or next((a for a in audio if a["kind"] == "同字參考詞"), None)
            or char_clips[0]
        )

        covered = syllables(r for a in audio for r in a["romanization"])
        questions.append({
            "id": f"{SECTION_PREFIX[section]}{no:03d}",
            "section": section,
            "no": no,
            "prompt": prompt,
            "promptNote": prompt_note,
            "target": target,
            "readings": readings,
            "speak": reference["word"],
            "speakRomanization": reference["romanization"],
            "reference": reference["file"],
            "audio": audio,
            "gaps": {
                "wordAudio": word_clip is None,
                "charAudio": not char_clips,
                "readings": [x for x in readings if x.lower() not in covered],
            },
        })

    return {
        "source": {
            "exam": "信義國小115學年度語文競賽—臺灣台語字音字形（題目引自113年全國語文競賽【國小組】）",
            "audio": "教育部《臺灣台語常用詞辭典》 https://sutian.moe.edu.tw/",
        },
        "audioBase": "taiwanese-pronunciation-130-mp3/mp3/",
        "sections": {
            s: sorted(q["no"] for q in questions if q["section"] == s)
            for s in SECTION_PREFIX
        },
        "questions": questions,
    }


def main():
    csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CSV
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    data = build(csv_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    qs = data["questions"]
    print(f"{len(qs)} 題 -> {out_path}")
    print("缺整詞錄音:", " ".join(q["id"] for q in qs if q["gaps"]["wordAudio"]))
    print("缺單字錄音:", sum(q["gaps"]["charAudio"] for q in qs), "題")
    print("缺腔調錄音:", " ".join(f'{q["id"]}({"/".join(q["gaps"]["readings"])})'
                             for q in qs if q["gaps"]["readings"]))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
