# taiwanese-quiz

台灣台語字音字形讀音練習網頁。題目取自信義國小 115 學年度語文競賽（引自 113 年全國語文競賽國小組），共 200 題；標準音為教育部《臺灣台語常用詞辭典》原始錄音。

- **測驗模式**：隨機出題，按住按鈕唸出讀音，放開後與標準音比對並給分。
- **練習模式**：依題號瀏覽，聽標準發音，不錄音。

需求與設計見 [docs/requirements.md](docs/requirements.md)，題目與音檔盤點見 [docs/audio-inventory.md](docs/audio-inventory.md)。

## 本機執行

純靜態網頁，不需要建置。用任何靜態伺服器在 repo 根目錄啟動即可，例如：

```sh
python -m http.server 8000
```

再開啟 <http://localhost:8000/>。直接雙擊 `index.html` 無法載入題庫；麥克風只能在 `localhost` 或 HTTPS 下使用。

網址加上 `?debug` 會顯示評分的原始數值。`tools/calibrate.html` 用標準音模擬比對，用來調整 `js/scoring.js` 的評分門檻。

## 部署

GitHub Pages：Settings → Pages → Source 選 `main` 分支、`/ (root)`。

## 檔案

| 路徑 | 內容 |
|---|---|
| `index.html`、`css/`、`js/` | 網頁 |
| `js/scoring.js` | 評分：MFCC + DTW 比對音段，YIN 音高曲線比對聲調 |
| `data/exam.csv` | 試卷逐題抄錄（題目依據） |
| `data/questions.json` | 題庫，由 `python scripts/build_questions.py` 產生 |
| `taiwanese-pronunciation-200-mp3/` | 教育部辭典原始 MP3 與對照表 |
| `docs/reference/` | 試卷照片 |
