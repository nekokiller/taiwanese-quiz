// 複習本：使用者自己勾選要再複習的題目，以題目 id 存在這台裝置的瀏覽器（localStorage）。
// 無痕模式或封鎖網站資料時存取會失敗，這時複習本只在這次瀏覽有效。

// GitHub Pages 同一個帳號的專案共用 origin，鍵名加上專案名稱避免衝突
const KEY = "taiwanese-quiz.review";

const ids = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // 無法保存，只在這次瀏覽有效
  }
}

export const inReview = (id) => ids.has(id);
export const reviewSize = () => ids.size;

export function setInReview(id, on) {
  if (on) ids.add(id);
  else ids.delete(id);
  save();
}

export function addToReview(idList) {
  for (const id of idList) ids.add(id);
  save();
}

export function clearReview() {
  ids.clear();
  save();
}

/** 移除題庫裡已經沒有的題目。 */
export function pruneReview(validIds) {
  const before = ids.size;
  for (const id of ids) if (!validIds.has(id)) ids.delete(id);
  if (ids.size !== before) save();
}
