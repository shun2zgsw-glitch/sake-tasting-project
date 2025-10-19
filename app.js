// ============================
// 要素参照（HTML内のidから必要なDOMを取得）
// ============================
const nicknameEl = document.getElementById('nickname'); // 参加者セレクト（上）
const listEl = document.getElementById('sake-list'); // 銘柄カードを差し込むコンテナ
const sendBtn = document.getElementById('sendBtn'); // 送信ボタン
const clearBtn = document.getElementById('clearBtn'); // 全リセットボタン
const refreshBtn = document.getElementById('refreshBtn'); // ランキング「更新」ボタン
const msgEl = document.getElementById('msg'); // 状態メッセージ（成功/失敗など）
const rankingEl = document.getElementById('ranking'); // トップ3の簡易ランキング
const metaEl = document.getElementById('meta'); // ランキングの更新時刻など

// ============================
// 状態（アプリの現在の値を保持）
// ============================
let SAKE_DATA = []; // 銘柄マスタ（GASから取得）
const currentScores = {}; // ユーザーが入力した星評価：key: s{idx} -> number(0〜10)
let eventsBound = false; // 二重でイベント登録されるのを防ぐフラグ
const FETCH_TIMEOUT = 12000; // 通信のタイムアウト(ms) 長過ぎる待機を避ける
let visualSelectedIndex = null; // 画像（ビジュアル）投票の単一選択インデックス
let VOTE_OPEN = true; // 投票受付状態（GASのsettingsで上書き）

// ============================
// ユーティリティ（汎用関数）
// ============================

/** 文字列のHTMLエスケープ（XSS対策：安全に表示するため） */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * fetchなどの非同期処理にタイムアウトを付ける
 * @param {(signal: AbortSignal) => Promise<any>} promise 実行関数（signalを受け取る）
 * @param {number} ms タイムアウト時間（ミリ秒）
 */
function withTimeout(promise, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms); // 規定時間で中断（Abort）
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), ms + 10)
    ),
  ]).finally(() => clearTimeout(t));
}

/**
 * 読み込み中表示（aria-busy）をON/OFF
 * スクリーンリーダーにも「処理中」を伝えられる
 */
function setBusy(el, busy) {
  if (!el) return;
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ============================
// 設定の取得とUI反映
// ============================

/**
 * GASのsettingsから受付状態を取得し、UIに反映
 * 失敗時は「受付中扱い」にするポリシー（必要に応じて変更可）
 */
async function loadVoteStatusAndApply() {
  try {
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=settings`, {
        cache: 'no-store', // 常に最新を取りに行く
        signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    VOTE_OPEN =
      String(d?.settings?.voteOpen ?? 'TRUE')
        .trim()
        .toUpperCase() === 'TRUE';
  } catch (e) {
    console.warn('settings load failed', e);
    VOTE_OPEN = true; // ← オフライン時などは受付中とみなす（運用方針に合わせて変更OK）
  }
  applyVoteOpenUI();
}

/** 受付状態に応じて送信ボタンやメッセージを切り替え */
function applyVoteOpenUI() {
  if (!VOTE_OPEN) {
    msgEl.textContent =
      '現在、投票受付は締め切られています。受付期間外のため送信できません。';
    sendBtn.disabled = true;
    sendBtn.setAttribute('aria-busy', 'false');
  } else {
    // 受付中に戻ったら締切メッセージを消す（他のメッセージは残す）
    if (msgEl.textContent.includes('締め切られています')) {
      msgEl.textContent = '';
    }
    updateSendButtonState();
  }
}

// ============================
// データ取得（GASから必要データを取ってくる）
// ============================

/** 銘柄マスタを取得して SAKE_DATA に格納 */
async function fetchSakeMaster() {
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=sakes`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // 期待形：{ ok, items }
    if (!data.ok) throw new Error(data.error || 'failed to load sakes');
    SAKE_DATA = Array.isArray(data.items) ? data.items : [];
  });
}

/** 参加者のセレクトを埋める（members_full：idと表示名を取得） */
async function populateMembers() {
  const sel = nicknameEl;
  return withTimeout(async (signal) => {
    const res = await fetch(`${window.GAS_API_URL}?type=members_full`, {
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); // 期待形：{ ok, items:[{id,name}] }

    // いったん初期化して先頭にプレースホルダを追加
    sel.innerHTML = '';
    sel.appendChild(new Option('選択してください', '', true, false));

    if (data.ok && Array.isArray(data.items)) {
      data.items.forEach(({ id, name }) => {
        const opt = new Option(name, id); // 値はmemberId
        opt.dataset.name = name; // 表示名も保持（後で送信に使う）
        sel.appendChild(opt);
      });
    } else {
      sel.appendChild(new Option('メンバー取得に失敗', '', true, false));
    }
  });
}

/** 集計（平均点ランキング）を取得して表示 */
async function fetchStats() {
  setBusy(rankingEl, true);
  try {
    const data = await withTimeout(async (signal) => {
      const res = await fetch(`${window.GAS_API_URL}?type=stats`, {
        method: 'GET',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json(); // 期待形：{ items, updatedAt }
    });
    renderRanking(data);
  } catch (e) {
    console.error(e);
    metaEl.textContent =
      '集計の取得に失敗しました。時間をおいて再試行してください。';
  } finally {
    setBusy(rankingEl, false);
  }
}

// ============================
// 描画（UIを生成して画面に差し込む）
// ============================

/**
 * 銘柄リスト（カード）＋ 星評価UI を描画
 * - 画像クリック：ビジュアル投票の単一選択
 * - 星10個：クリック/キー操作で0〜10を切替
 * - クリアボタン：その銘柄の入力を0に戻す
 */
function renderInputs() {
  listEl.innerHTML = '';
  setBusy(listEl, true);

  const frag = document.createDocumentFragment();

  (SAKE_DATA || []).forEach((it, idx) => {
    const key = `s${idx}`; // 星評価のキー（currentScores のプロパティ名）

    const wrap = document.createElement('div');
    wrap.className = 'item';
    wrap.dataset.index = String(idx); // 視覚選択（ビジュアル投票）用にindexを持たせる

    // 銘柄カードのHTML（descは省略表示にして「続きを読む」で展開）
    wrap.innerHTML = `
      <img class="thumb"
           src="${esc(it.img || '')}"
           alt="${esc(it.name || '')}"
           loading="lazy"
           decoding="async">
      <div class="body">
        <h3>${idx + 1}. ${esc(it.name || '')}</h3>
        <div class="meta-row">
          ${it.type ? `<span class="pill">【${esc(it.type)}】</span>` : ''}
          ${
            it.brewery
              ? it.breweryUrl
                ? `<a href="${esc(
                    it.breweryUrl
                  )}" class="pill link" target="_blank" rel="noopener noreferrer">${esc(
                    it.brewery
                  )}</a>`
                : `<span class="pill">${esc(it.brewery)}</span>`
              : ''
          }
          ${
            it.exhibitor
              ? `<span class="pill">出品者：${esc(it.exhibitor)}</span>`
              : ''
          }
        </div>

        <p class="desc clamp" data-desc="${key}">${esc(it.desc || '')}</p>
        <button class="more-btn" type="button" data-more="${key}">続きを読む</button>

        <div class="star-row" data-row="${key}">
          <div class="stars" role="radiogroup" aria-label="${esc(
            it.name || ''
          )} の評価（0〜10）"></div>
          <div class="scale-labels" aria-hidden="true">
            <span class="label-min">1</span>
            <span class="label-mid">5</span>
            <span class="label-max">10</span>
          </div>
        </div>

        <div class="clear-wrap">
          <button class="clear-mini" type="button" data-clear="${key}" aria-label="この銘柄の評価をクリア">クリア</button>
        </div>
      </div>
    `;

    // 星10個を生成（role="radio"でアクセシブルに）
    const starsBox = wrap.querySelector('.stars');
    for (let v = 1; v <= 10; v++) {
      const span = document.createElement('span');
      span.className = 'star';
      span.setAttribute('role', 'radio');
      span.setAttribute('tabindex', '0');
      span.dataset.key = key;
      span.dataset.value = String(v);
      span.setAttribute('aria-label', `${v} 点`);
      span.textContent = '★';
      starsBox.appendChild(span);
    }

    // 画像クリックでビジュアル投票（単一選択トグル）
    const img = wrap.querySelector('.thumb');
    img.addEventListener('click', () => {
      const memberId = (nicknameEl.value || '').trim();
      // 出品者は自銘柄へのビジュアル投票不可
      if (
        memberId &&
        String(SAKE_DATA[idx].exhibitorMemberId || '') === memberId
      ) {
        msgEl.textContent = '出品者はビジュアル投票できません。';
        return;
      }
      // 同じカードを再クリックで選択解除
      visualSelectedIndex = visualSelectedIndex === idx ? null : idx;
      updateVisualSelectionUI();
      updateSendButtonState();
    });

    frag.appendChild(wrap);
  });

  // 挿入＆初期化
  listEl.appendChild(frag);
  currentScoresReset();
  setBusy(listEl, false);

  // リスト内イベントは最初の1回だけ登録
  if (!eventsBound) {
    listEl.addEventListener('click', onStarsClick); // 星クリック
    listEl.addEventListener('keydown', onStarsKeydown); // 星キーボード操作
    listEl.addEventListener('click', onClearMini); // 個別クリア
    listEl.addEventListener('click', onMoreToggle); // 読む/閉じる
    eventsBound = true;
  }

  applySelfVoteDisable(); // 出品者の自己投票無効化（星/画像）
  updateVisualSelectionUI(); // 視覚的な選択枠の反映
}

/** ビジュアル投票の選択見た目（簡易：インラインスタイルで枠を付ける） */
function updateVisualSelectionUI() {
  listEl.querySelectorAll('.item').forEach((item) => {
    const idx = Number(item.dataset.index || -1);
    const selected = visualSelectedIndex === idx;
    item.style.border = selected ? '2px solid var(--primary)' : '';
    item.style.boxShadow = selected ? '0 0 0 2px rgba(26,115,232,0.12)' : '';
  });
}

/** 簡易ランキング（上位3件）を描画 */
function renderRanking({ items = [], updatedAt = '' } = {}) {
  rankingEl.innerHTML = '';

  if (!items.length) {
    rankingEl.innerHTML = `<li>まだ集計データがありません</li>`;
  } else {
    const top3 = items.filter((it) => it.count > 0).slice(0, 3);
    if (!top3.length) {
      rankingEl.innerHTML = `<li>まだ投票がありません</li>`;
    } else {
      const frag = document.createDocumentFragment();
      top3.forEach((it, i) => {
        const li = document.createElement('li');
        const medal = ['🥇', '🥈', '🥉'][i] || '';
        li.innerHTML = `
          ${medal} <strong>${esc(it.name)}</strong>
          — 平均 <strong>${Number(it.avg).toFixed(2)}</strong> 点（${
          it.count
        }票）
        `;
        frag.appendChild(li);
      });
      rankingEl.appendChild(frag);
    }
  }

  metaEl.textContent = updatedAt
    ? `最終更新: ${new Date(updatedAt).toLocaleString()}`
    : '';
}

/** ビジュアル投票が選択されているか？ */
function hasVisualVote() {
  return visualSelectedIndex !== null;
}

// ============================
// イベントハンドラ群（UI操作時の
