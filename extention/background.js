const SERVER = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "api") return;

  fetch(SERVER + msg.path, {
    method: msg.method || "POST",
    headers: { "Content-Type": "application/json" },
    body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
  })
    .then(async (res) => {
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      sendResponse({ ok: res.ok, status: res.status, data });
    })
    .catch((err) => {
      // サーバーに接続できなかった場合
      sendResponse({ ok: false, networkError: true, error: String(err) });
    });

  return true; // 非同期でsendResponseを呼ぶために
});