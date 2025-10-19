// ============================
// 要素参照（HTML内のidを使って必要なDOMを取得）
// ============================
const toggleBtn = document.getElementById('toggleBtn'); // 受付のON/OFF切替ボタン
const voteOpenLabel = document.getElementById('voteOpenLabel'); // 現在の受付状態（受付中/締切）
const adminMsg = document.getElementById('adminMsg'); // 管理メッセージ表示領域

const rankList = document.getElementById('rankList'); // 平均点ランキングの <ol>
const rankMeta = document.getElementById('rankMeta'); // ランキングの更新時刻など
const refreshStatsBtn = document.getElementById('refreshStatsBtn'); // ランキング再読込ボタン

const visualList = document.getElementById('visualList'); // ビジュアル投票の <ol>
const visualMeta = document.getElementById('visualMeta'); // ビジュアル投票の更新時刻など
const refreshVisualBtn = document.getElementById('refreshVisualBtn'); // ビジュアル投票再読込ボタン

// ============================
// 状態/ユーティリティ
// ============================
const FETCH_TIMEOUT = 12000; // 取得系APIのタイムアウト（ms）。回線不調時に待ち続けないための保険

// 折りたたみ状態（ページを再描画しても保持したいトグルの開閉状態）
let statsExpanded = false; // 平均点ランキングの展開状態
let visualExpanded = false; // ビジュアル投票の展開状態

// HTMLエスケープ（XSS対策：表示用に文字を無害化）
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * fetchをタイムアウト付きで走らせるヘルパー
 * @param {(signal: AbortSignal) => Promise<any>} promise fetchなどの処理を返す関数
 * @param {number} ms タイムアウト時間（ms）
 * @returns {Promise<any>} 処理の結果
 */
function withTimeout(promise, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms); // 規定時間で中断
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), ms + 10)
    ),
  ]).finally(() => clearTimeout(t)); // 後片付け
}

/**
 * 要素の aria-busy を制御（アクセシビリティ向上）
 * 読み上げソフトに「いま読み込み中だよ」を伝えられる
 */
function setBusy(el, busy) {
  if (!el) return;
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ========= 折りたたみ制御（共通） =========

/**
 * リストの直後に「さらに表示」ボタンを置くラッパー要素を確保
 * 無ければ生成して after() で差し込む
 */
function ensureToggleWrap(listEl, id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'list-toggle-wrap';
    listEl.after(el);
  }
  return el;
}

/**
 * リストの6位以降を非表示にし、トグルボタンで展開できるようにする
 * @param {HTMLOListElement} listEl 対象の <ol>
 * @param {number} keep 表示し続ける件数（上位N位）
 * @param {boolean} expanded 現在の展開状態
 * @param {(expanded:boolean)=>void} setExpanded 展開状態更新コールバック
 * @param {string} wrapId トグルラッパーの一意ID（DOM重複回避）
 */
function applyCollapsible(listEl, keep, expanded, setExpanded, wrapId) {
  const items = Array.from(listEl.children || []);

  // 表示/非表示を切替（上位keep件だけ表示、展開時は全表示）
  items.forEach((li, i) => {
    li.classList.toggle('is-hidden', !expanded && i >= keep);
  });

  // トグルUIの描画（毎回作り直して状態と件数を正しく反映）
  const wrap = ensureToggleWrap(listEl, wrapId);
  wrap.innerHTML = ''; // 初期化

  if (items.length > keep) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn list-toggle';
    btn.setAttribute('aria-expanded', String(expanded));
    btn.textContent = expanded
      ? '閉じる'
      : `さらに表示（${items.length - keep} 件）`;
    btn.addEventListener('click', () => {
      setExpanded(!expanded);
      applyCollapsible(listEl, keep, !expanded, setExpanded, wrapId);
      // スクロールが大きく動かないように近傍へ
      btn.scrollIntoView({ block: 'nearest' });
    });
    wrap.appendChild(btn);
  }
}

// ============================
// 投票受付 表示/切替
// ============================

/**
 * 現在の受付状態（TRUE/FALSE）をGASから取得してUIに反映
 */
async function loadVoteOpen() {
  try {
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=settings`, {
        signal,
        cache: 'no-store', // キャッシュ無効（常に最新）
      });
      return r.json();
    });

    // settings.voteOpen が 'TRUE' なら受付中
    const open =
      String(d?.settings?.voteOpen ?? 'TRUE')
        .trim()
        .toUpperCase() === 'TRUE';

    // 表示とボタン文言を同期
    voteOpenLabel.textContent = open ? '受付中' : '締切';
    toggleBtn.textContent = open ? '締切にする' : '受付にする';
    toggleBtn.dataset.open = String(open); // 後で参照するためデータ属性に保存
  } catch (e) {
    adminMsg.textContent = '受付状態の取得に失敗しました。';
    console.warn(e);
  }
}

/**
 * 受付状態をトグル（GAS側で反転させるAPIを叩く想定）
 */
async function toggleVoteOpen() {
  const nowOpen = String(toggleBtn.dataset.open) === 'true'; // 現在状態
  toggleBtn.disabled = true;
  toggleBtn.setAttribute('aria-busy', 'true');
  adminMsg.textContent = '切り替え中...';

  try {
    // ※ GAS側のハンドラ名は運用に合わせて変更（toggle_open）
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=toggle_open`, {
        method: 'POST', // トグルなのでPOST
        signal,
      });
      const t = await r.text(); // 失敗時にJSON以外が来ても壊れないようにまずはtextで
      try {
        return JSON.parse(t);
      } catch {
        return { ok: false, error: t }; // テキストをそのままエラーに載せる
      }
    });

    if (d?.ok) {
      adminMsg.textContent = '受付状態を更新しました。';
      await loadVoteOpen(); // 最新状態を再取得してUIを同期
    } else {
      adminMsg.textContent = `更新に失敗しました：${d?.error ?? 'unknown'}`;
    }
  } catch (e) {
    adminMsg.textContent = '通信エラーが発生しました。';
    console.error(e);
  } finally {
    toggleBtn.disabled = false;
    toggleBtn.setAttribute('aria-busy', 'false');
  }
}

// ============================
// ランキング（平均点）
// ============================

/**
 * 平均点ランキングを取得して描画
 * - スケルトン（空表示）にしてから取得
 * - 取得後、折りたたみUIを適用
 */
async function loadStats() {
  setBusy(rankList, true);
  rankList.innerHTML = '';
  rankMeta.textContent = '';
  try {
    const { items = [], updatedAt = '' } = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=stats`, {
        signal,
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    renderRankList(items);

    // 更新時刻（ISO想定）をローカル表示に整形
    rankMeta.textContent = updatedAt
      ? `最終更新：${new Date(updatedAt).toLocaleString()}`
      : '';

    // 上位5位以外を折りたたみ（展開状態は statsExpanded を保持）
    applyCollapsible(
      rankList,
      5,
      statsExpanded,
      (v) => {
        statsExpanded = v;
      },
      'rankToggleWrap'
    );
  } catch (e) {
    rankList.innerHTML = `<li class="rank-item"><span class="rank-name">取得に失敗しました</span></li>`;
    console.error(e);
  } finally {
    setBusy(rankList, false);
  }
}

/**
 * ランキングのリストを描画
 * - 平均点（降順）、同点時は投票数（降順）で並べる
 * - 1〜3位はバッジ用クラスを追加（スタイルで金銀銅など）
 */
function renderRankList(items) {
  const arr = Array.isArray(items) ? [...items] : [];
  arr.sort(
    (a, b) => (b?.avg ?? 0) - (a?.avg ?? 0) || (b?.count ?? 0) - (a?.count ?? 0)
  );

  const frag = document.createDocumentFragment();

  arr.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'rank-item';
    if (i === 0) li.classList.add('top1');
    if (i === 1) li.classList.add('top2');
    if (i === 2) li.classList.add('top3');

    // 1〜3位はメダル、それ以降は順位数字
    const medal =
      i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);

    // 文字列は必ずエスケープして安全に表示
    li.innerHTML = `
      <div class="rank-badge" aria-label="${i + 1}位">${esc(medal)}</div>
      <div class="rank-name-wrap">
        ${i === 0 ? `<div class="rank-crown" aria-hidden="true">👑</div>` : ``}
        <div class="rank-name" title="${esc(it.name || '')}">${esc(
      it.name || `No.${i + 1}`
    )}</div>
        <small class="rank-sub">${it.type ? `【${esc(it.type)}】` : ''}${
      it.brewery ? `　${esc(it.brewery)}` : ''
    }</small>
      </div>
      <div class="rank-score">
        <span class="avg">${Number(it.avg ?? 0).toFixed(2)}</span>
        <small class="count">（${Number(it.count ?? 0)} 票）</small>
      </div>
    `;

    frag.appendChild(li);
  });

  rankList.innerHTML = '';
  rankList.appendChild(frag);
}

// ============================
// ビジュアル投票（得票数）
// ============================

/**
 * ビジュアル投票の得票数を取得して描画
 */
async function loadVisual() {
  setBusy(visualList, true);
  visualList.innerHTML = '';
  visualMeta.textContent = '';
  try {
    const { items = [], updatedAt = '' } = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=visual_stats`, {
        signal,
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    renderVisualList(items);

    visualMeta.textContent = updatedAt
      ? `最終更新：${new Date(updatedAt).toLocaleString()}`
      : '';

    // 上位5位以外を折りたたみ（展開状態は visualExpanded を保持）
    applyCollapsible(
      visualList,
      5,
      visualExpanded,
      (v) => {
        visualExpanded = v;
      },
      'visualToggleWrap'
    );
  } catch (e) {
    visualList.innerHTML = `<li class="rank-item"><span class="rank-name">取得に失敗しました</span></li>`;
    console.error(e);
  } finally {
    setBusy(visualList, false);
  }
}

/**
 * ビジュアル投票結果の描画
 * - 得票数（降順）、同票時は名前の昇順で安定ソート
 */
function renderVisualList(items) {
  const arr = Array.isArray(items) ? [...items] : [];
  arr.sort(
    (a, b) =>
      (b?.votes ?? 0) - (a?.votes ?? 0) ||
      String(a.name).localeCompare(String(b.name))
  );

  const frag = document.createDocumentFragment();

  arr.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'rank-item';
    if (i === 0) li.classList.add('top1');
    if (i === 1) li.classList.add('top2');
    if (i === 2) li.classList.add('top3');

    const medal =
      i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);

    li.innerHTML = `
      <div class="rank-badge" aria-label="${i + 1}位">${esc(medal)}</div>
      <div class="rank-name-wrap">
        ${i === 0 ? `<div class="rank-crown" aria-hidden="true">👑</div>` : ``}
        <div class="rank-name" title="${esc(it.name || '')}">${esc(
      it.name || `No.${i + 1}`
    )}</div>
      </div>
      <div class="rank-score">
        <span class="avg">${Number(it.votes ?? 0)}</span>
        <small class="count">票</small>
      </div>
    `;

    frag.appendChild(li);
  });

  visualList.innerHTML = '';
  visualList.appendChild(frag);
}

// ============================
// 起動（イベント紐付け → 初回ロード）
// ============================

/**
 * 各ボタンにイベントを結びつける
 */
function bindEvents() {
  refreshStatsBtn?.addEventListener('click', loadStats);
  refreshVisualBtn?.addEventListener('click', loadVisual);
  toggleBtn?.addEventListener('click', toggleVoteOpen);
}

/**
 * 初期化：イベント登録 → 必要データの初回読込
 */
async function init() {
  bindEvents();
  await loadVoteOpen();
  await loadStats();
  await loadVisual();
}

// スクリプト開始
init();
