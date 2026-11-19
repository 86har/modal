const CONFIG = {
  // true: DeepLがライトモードのとき、ページ全体を強制的にダーク表示にする
  forceDark: true,

  // true: mainSectionWrapper 以外の要素（同じ親の中の兄弟）を非表示にする
  hideSiblings: true,
  mainSectionSelector: '[data-layout-id="mainSectionWrapper"]',

  targetSelector: '[data-layout-id="editor-layout-footer"]',
  // mainSectionWrapper の中では、この見出しの「辞書」カードより後ろの要素を非表示にする。
  // DeepLの表示言語が日本語以外のときは書き換える（例: "Dictionary"）。
  // 見出しが見つからないときは targetSelector（editor-layout-footer）より後ろを隠す。
  dictionaryHeading: "辞書",

  targetSelector: '[data-layout-id="editor-layout-footer"]',
  position: "beforebegin",
  injectedId: "my-injected-element",

  // 翻訳結果（出力側）のテキストを取得するセレクタ。上から順に試して、最初に文字が取れたものを使う。
  // ※DeepL側の構造が変わったら、ここを書き換える
  translationSelectors: [
    '[data-testid="translator-target-input"]',
    "#target-dummydiv",
  ],

  // 翻訳元（入力側）エディタのセレクタ。ここにフォーカスがある状態でCtrl+Enterを押すと生成を実行する。
  // ※DeepL側の構造が変わったら、ここを書き換える
  sourceSelectors: [
    '[data-testid="translator-source-input"]',
    "#source-dummydiv",
  ],
};

const SLIDER = { min: 512, max: 2048, step: 16 };
const HTML = `
<div class="my-injected-element">
    <h3>画像を生成する</h3>
    <div class="meta-container">
        <div class="meta-data-container">
            <div class="meta-data-item" data-slider data-unit="px">
                <input type="range" class="slider-range"
                    min="${SLIDER.min}" max="${SLIDER.max}" step="${SLIDER.step}" value="1024">
                <div class="slider-label-row">
                    <span class="slider-label">Width</span>
                    <span class="slider-value">1024px</span>
                </div>
            </div>
            <button type="button" class="swap-button" aria-label="widthとheightを入れ替える">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 8h15M15 4l4 4-4 4"/>
                    <path d="M20 16H5M9 12l-4 4 4 4"/>
                </svg>
            </button>
            <div class="meta-data-item" data-slider data-unit="px">
                <input type="range" class="slider-range"
                    min="${SLIDER.min}" max="${SLIDER.max}" step="${SLIDER.step}" value="1024">
                <div class="slider-label-row">
                    <span class="slider-label">Height</span>
                    <span class="slider-value">1024px</span>
                </div>
            </div>
            <div class="meta-data-item nums-of-gen" data-slider data-unit="枚">
                <input type="range" class="slider-range"
                    min="1" max="25" step="1" value="1">
                <div class="slider-label-row">
                    <span class="slider-label">生成枚数</span>
                    <span class="slider-value">1枚</span>
                </div>
            </div>
        </div>
        <div class="generates" data-state="idle">
          <p>翻訳画面に入力してください</p>
          <button type="button" id="generate_btn" disabled>生成</button>
        </div>
    </div>
</div>
`;

// ローカルPythonサーバーへリクエストを送る（background.js経由）
// 例: const res = await callApi("/api/echo", { text: "hello" });
function callApi(path, body, method = "POST") {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "api", path, body, method }, resolve);
  });
}

// 生成ボタン横の状態表示。data-state は CSS 側のボーダー色に対応（noServer / error はどちらも赤）
const STATUS = {
  idle: { text: "翻訳画面に入力してください" },
  ready: { text: "" },
  queued: { text: "予約完了、次回の生成で出力されます" },
  started: { text: "生成が開始されました" },
  noServer: { text: "gen.pyを起動しているか確認してください" },
  error: { text: "予期せぬエラーが発生しました" },
};

function setStatus(el, key) {
  const box = el.querySelector(".generates");
  if (box.dataset.state === key) return; // 変化がなければDOMに触らない
  const label = box.querySelector("p");
  box.dataset.state = key;
  label.textContent = STATUS[key].text;
}

// 翻訳結果の有無でボタンの有効/無効を切り替える
function updateGenerateState() {
  const el = document.getElementById(CONFIG.injectedId);
  if (!el) return;
  const btn = el.querySelector("#generate_btn");
  const hasText = !!getTranslatedText();
  if (btn.disabled === hasText) btn.disabled = !hasText;

  // 待機中の表示だけは入力の有無に追従させる（結果表示は上書きしない）
  const state = el.querySelector(".generates").dataset.state;
  if (state === "idle" || state === "ready") {
    setStatus(el, hasText ? "ready" : "idle");
  }
}

// スライダーの塗り部分の長さをCSS変数に反映する
function updateFill(range) {
  const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
  range.style.setProperty("--fill", `${pct}%`);
}

// スライダーと現在値の表示を連動させる
function setupSlider(item) {
  const range = item.querySelector(".slider-range");
  const value = item.querySelector(".slider-value");
  const unit = item.dataset.unit || "";

  const sync = () => {
    value.textContent = `${range.value}${unit}`;
    updateFill(range);
  };
  sync();
  range.addEventListener("input", sync);
}

// 現在の翻訳結果を取得する。取れなければ空文字
function getTranslatedText() {
  for (const selector of CONFIG.translationSelectors) {
    const node = document.querySelector(selector);
    const text = (node?.innerText || node?.textContent || "").trim();
    if (text) return text;
  }
  return "";
}

// 画面の端をふわっと光らせる。kind: "press"(青) / "error"(赤)
function flashGlow(kind = "press") {
  let glow = document.getElementById("my-glow-overlay");
  if (!glow) {
    glow = document.createElement("div");
    glow.id = "my-glow-overlay";
    glow.className = "my-glow-overlay";
    glow.addEventListener("animationend", () => glow.classList.remove("is-active"));
    document.body.appendChild(glow);
  }
  glow.dataset.kind = kind;
  glow.classList.remove("is-active");
  void glow.offsetWidth; // 連打してもアニメーションを最初からやり直す
  glow.classList.add("is-active");
}

// ===== ダークモード対応 =====
// DeepLにはダークモードがないので、ページ全体の色を反転して擬似的にダークにする。
// CSSファイルの読み込み状況に左右されないよう、ルールはここから <style> として直接注入する。
const FORCE_DARK_CSS = `
html.my-force-dark {
  background-color: #ffffff !important;
  filter: invert(1) hue-rotate(180deg) !important;
}
html.my-force-dark img,
html.my-force-dark picture,
html.my-force-dark video,
html.my-force-dark canvas,
html.my-force-dark iframe,
html.my-force-dark [style*="background-image"],
html.my-force-dark .my-injected-element,
html.my-force-dark .my-glow-overlay {
  filter: invert(1) hue-rotate(180deg) !important;
}
.my-hidden-below {
  display: none !important;
}
`;

function ensureForceDarkStyle() {
  if (document.getElementById("my-force-dark-style")) return;
  const style = document.createElement("style");
  style.id = "my-force-dark-style";
  style.textContent = FORCE_DARK_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// mainSectionWrapper の兄弟要素（前後どちらも）を隠す
function ensureHideSiblingsStyle() {
  const id = "my-hide-siblings-style";
  const existing = document.getElementById(id);

  if (!CONFIG.hideSiblings) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const s = CONFIG.mainSectionSelector;
  const style = document.createElement("style");
  style.id = id;
  // 後ろの兄弟: s ~ *  /  前の兄弟: :has(~ s)
  style.textContent = `
${s} ~ *,
:has(~ ${s}) {
  display: none !important;
}`;
  (document.head || document.documentElement).appendChild(style);
}

function applyTheme() {
  ensureHideSiblingsStyle();

  // forceDark が false のときだけ、CSS側の反転を打ち消す
  let off = document.getElementById("my-force-dark-off");
  if (!CONFIG.forceDark) {
    if (!off) {
      off = document.createElement("style");
      off.id = "my-force-dark-off";
      off.textContent = `html { filter: none !important; }`;
      (document.head || document.documentElement).appendChild(off);
    }
  } else {
    off?.remove();
  }

  const el = document.getElementById(CONFIG.injectedId);
  if (el && el.dataset.theme !== "dark") el.dataset.theme = "dark";
}

// ===== mainSectionWrapper 以外・辞書より後ろを消す =====
// 辞書の見出しから「辞書のカード全体」を割り出す（mainSectionWrapper の中だけを探す）
function findDictionaryCard(main) {
  const heading = [...main.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p")].find(
    (n) => n.children.length === 0 && n.textContent.trim() === CONFIG.dictionaryHeading
  );
  if (!heading) return null;

  let card = heading;
  while (card.parentElement && card.parentElement !== main) {
    const parent = card.parentElement;
    if (parent.querySelector(CONFIG.sourceSelectors.join(","))) break; // 翻訳欄まで含んだら行き過ぎ
    if (parent.getBoundingClientRect().height > 300) break;
    card = parent;
  }
  return card;
}

function hideEl(el) {
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
  if (el.classList.contains("my-hidden-below")) return;
  const mine = document.getElementById(CONFIG.injectedId);
  if (mine && el.contains(mine)) return; // 差し込んだパネルを含む要素は隠さない
  el.classList.add("my-hidden-below");
}

// 要素は削除せず display:none にする（DeepLの再描画と衝突しないため）
function hideOutsideMainSection() {
  if (!CONFIG.hideOutsideMainSection) return;
  const main = document.querySelector(CONFIG.mainSectionSelector);
  if (!main || !main.parentElement) return;

  // 1) mainSectionWrapper の兄弟をすべて隠す
  for (const sib of main.parentElement.children) {
    if (sib !== main) hideEl(sib);
  }

  // 2) mainSectionWrapper の中では、辞書（なければ editor-layout-footer）より後ろを隠す
  const anchor = findDictionaryCard(main) || main.querySelector(CONFIG.targetSelector);
  if (!anchor) return;
  for (let node = anchor; node && node !== main; node = node.parentElement) {
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      hideEl(sib);
    }
  }
}

// HTMLからDOM要素を作る
function createElementToInject() {
  const template = document.createElement("template");
  template.innerHTML = HTML.trim();
  const el = template.content.firstElementChild;
  el.id = CONFIG.injectedId;

  el.querySelectorAll("[data-slider]").forEach(setupSlider);

  const swapButton = el.querySelector(".swap-button");
  if (swapButton) {
    swapButton.addEventListener("click", () => {
      const [widthRange, heightRange] = el.querySelectorAll(".slider-range");
      const tmp = widthRange.value;
      widthRange.value = heightRange.value;
      heightRange.value = tmp;
      widthRange.dispatchEvent(new Event("input"));
      heightRange.dispatchEvent(new Event("input"));
    });
  }

  const generateBtn = el.querySelector("#generate_btn");
  generateBtn.addEventListener("click", () => runGenerate(el, generateBtn));
  return el;
}

// 生成ボタンを押したときの処理本体。ボタンクリックからもCtrl+Enterのショートカットからも呼ばれる。
async function runGenerate(el, generateBtn) {
  if (generateBtn.disabled) return;
  const [widthRange, heightRange, numsRange] = el.querySelectorAll(".slider-range");

  // 押した時点の翻訳結果をpromptとして送る
  const prompt = getTranslatedText();
  if (!prompt) {
    updateGenerateState();
    return;
  }

  flashGlow("press"); // ← 追加：押せたことを即フィードバック

  const res = await callApi("/api/generate", {
    prompt: prompt,
    height: heightRange.value,
    width: widthRange.value,
    nums: numsRange.value,
  });

  if (res?.networkError) {
    setStatus(el, "noServer");
    flashGlow("error"); // ← 追加
  } else if (res?.ok) {
    setStatus(el, res.data?.queued ? "queued" : "started");
  } else {
    setStatus(el, "error"); 
    flashGlow("error"); // ← 追加
  }
}

// 現在フォーカスしている要素が、翻訳元（入力側）エディタの中かどうかを判定する
function isFocusInSourceEditor() {
  const active = document.activeElement;
  if (!active) return false;
  return CONFIG.sourceSelectors.some((selector) => {
    const container = document.querySelector(selector);
    return container && container.contains(active);
  });
}

// ソース側エディタでCtrl+Enter（Macの場合はCmd+Enterも）が押されたら、生成ボタンを押したのと同じ処理を走らせる
function setupGenerateShortcut() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!isFocusInSourceEditor()) return;

    const el = document.getElementById(CONFIG.injectedId);
    if (!el) return;
    const generateBtn = el.querySelector("#generate_btn");
    if (!generateBtn) return;

    e.preventDefault();
    runGenerate(el, generateBtn);
  });
}

function inject() {
  if (document.getElementById(CONFIG.injectedId)) return true;

  const target = document.querySelector(CONFIG.targetSelector);
  if (!target) return false;

  target.insertAdjacentElement(CONFIG.position, createElementToInject());
  applyTheme();
  updateGenerateState();
  return true;
}

// Ctrl+Enter(Cmd+Enter)での生成ショートカットを有効化
setupGenerateShortcut();

// 最初に一度試す
inject();
applyTheme();
hideOutsideMainSection();

// SPAなどで後から描画されるだとか再描画で消される場合に備えて監視する
let refreshTimer = null;
const observer = new MutationObserver((mutations) => {
  const mine = document.getElementById(CONFIG.injectedId);

  // 自分が差し込んだ要素の中の変化だけなら何もしない（自分の更新で再発火するのを防ぐ）
  if (mine && mutations.every((m) => mine.contains(m.target))) return;

  // DeepL側は頻繁にDOMが変わるので、まとめて少し待ってから1回だけ処理する
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!document.getElementById(CONFIG.injectedId)) inject();
    applyTheme();
    hideOutsideMainSection();
    updateGenerateState();
  }, 150);
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

// DeepLのテーマ切り替え（html/bodyのclassやstyleの変化）とOSのダーク設定の変化に追従する
let themeTimer = null;
const scheduleTheme = () => {
  clearTimeout(themeTimer);
  themeTimer = setTimeout(applyTheme, 100);
};
const themeObserver = new MutationObserver(scheduleTheme);
[document.documentElement, document.body].forEach((node) => {
  if (node) {
    themeObserver.observe(node, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-scheme"],
    });
  }
});