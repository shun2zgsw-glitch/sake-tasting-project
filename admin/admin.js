// ============================
// 要素参照
// ============================
const toggleBtn = document.getElementById('toggleBtn');
const voteOpenLabel = document.getElementById('voteOpenLabel');
const adminMsg = document.getElementById('adminMsg');

const rankList = document.getElementById('rankList');
const rankMeta = document.getElementById('rankMeta');
const refreshStatsBtn = document.getElementById('refreshStatsBtn');

const visualList = document.getElementById('visualList');
const visualMeta = document.getElementById('visualMeta');
const refreshVisualBtn = document.getElementById('refreshVisualBtn');

const refreshCheckBtn = document.getElementById('refreshCheckBtn');
const voteCheckBody = document.getElementById('voteCheckBody');
const checkMeta = document.getElementById('checkMeta');

// ============================
// 状態/ユーティリティ
// ============================
const FETCH_TIMEOUT = 12000;

// 折りたたみ状態（再描画しても保持）
let statsExpanded = false; // 平均点ランキング
let visualExpanded = false; // ビジュアル投票

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function withTimeout(promise, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), ms + 10),
    ),
  ]).finally(() => clearTimeout(t));
}

function setBusy(el, busy) {
  if (!el) return;
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ========= 折りたたみ制御（共通） =========
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
 * リストの6位以降を非表示にし、トグルボタンを設置
 * @param {HTMLOListElement} listEl 対象の <ol>
 * @param {number} keep 表示し続ける件数（上位N位）
 * @param {boolean} expanded 展開状態
 * @param {function(boolean):void} setExpanded 状態更新コールバック
 * @param {string} wrapId トグルラッパーの一意ID
 */
function applyCollapsible(listEl, keep, expanded, setExpanded, wrapId) {
  const items = Array.from(listEl.children || []);
  // 表示/非表示を切替
  items.forEach((li, i) => {
    li.classList.toggle('is-hidden', !expanded && i >= keep);
  });

  // トグルUI
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
      // スクロール位置が飛ばないように小さく調整（任意）
      btn.scrollIntoView({ block: 'nearest' });
    });
    wrap.appendChild(btn);
  }
}

// ============================
// 投票受付 表示/切替
// ============================
async function loadVoteOpen() {
  try {
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=settings`, {
        signal,
        cache: 'no-store',
      });
      return r.json();
    });
    const open =
      String(d?.settings?.voteOpen ?? 'TRUE')
        .trim()
        .toUpperCase() === 'TRUE';
    voteOpenLabel.textContent = open ? '受付中' : '締切';
    toggleBtn.textContent = open ? '締切にする' : '受付にする';
    toggleBtn.dataset.open = String(open);
  } catch (e) {
    adminMsg.textContent = '受付状態の取得に失敗しました。';
    console.warn(e);
  }
}

async function toggleVoteOpen() {
  const nowOpen = String(toggleBtn.dataset.open) === 'true';
  toggleBtn.disabled = true;
  toggleBtn.setAttribute('aria-busy', 'true');
  adminMsg.textContent = '切り替え中...';

  try {
    // 環境に合わせてエンドポイント名を調整
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=toggle_open`, {
        signal,
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    if (d?.ok) {
      adminMsg.textContent = '受付状態を更新しました。';
      await loadVoteOpen();
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
async function loadStats(forceRefresh = false) {
  setBusy(rankList, true);
  rankList.innerHTML = '';
  rankMeta.textContent = '';

  const refreshQS = forceRefresh ? '&refresh=1' : '';

  try {
    const { items = [], updatedAt = '' } = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=stats${refreshQS}`, {
        signal,
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    renderRankList(items);
    rankMeta.textContent = updatedAt
      ? `最終更新：${new Date(updatedAt).toLocaleString()}`
      : '';

    applyCollapsible(
      rankList,
      5,
      statsExpanded,
      (v) => (statsExpanded = v),
      'rankToggleWrap',
    );
  } catch (e) {
    rankList.innerHTML = `<li class="rank-item"><span class="rank-name">取得に失敗しました</span></li>`;
    console.error(e);
  } finally {
    setBusy(rankList, false);
  }
}

function renderRankList(items) {
  const arr = Array.isArray(items) ? [...items] : [];
  arr.sort(
    (a, b) =>
      (b?.avg ?? 0) - (a?.avg ?? 0) || (b?.count ?? 0) - (a?.count ?? 0),
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
          it.name || `No.${i + 1}`,
        )}</div>
        <small class="rank-sub">${it.type ? `【${esc(it.type)}】` : ''}${
          it.brewery ? `　${esc(it.brewery)}` : ''
        }</small>
      </div>
      <div class="rank-score">
         <span class="avg">${Math.round(Number(it.avg ?? 0))}</span>
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
async function loadVisual(forceRefresh = false) {
  setBusy(visualList, true);
  visualList.innerHTML = '';
  visualMeta.textContent = '';

  const refreshQS = forceRefresh ? '&refresh=1' : '';

  try {
    const { items = [], updatedAt = '' } = await withTimeout(async (signal) => {
      const r = await fetch(
        `${window.GAS_API_URL}?type=visual_stats${refreshQS}`,
        {
          signal,
          cache: 'no-store',
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    renderVisualList(items);
    visualMeta.textContent = updatedAt
      ? `最終更新：${new Date(updatedAt).toLocaleString()}`
      : '';

    applyCollapsible(
      visualList,
      5,
      visualExpanded,
      (v) => (visualExpanded = v),
      'visualToggleWrap',
    );
  } catch (e) {
    visualList.innerHTML = `<li class="rank-item"><span class="rank-name">取得に失敗しました</span></li>`;
    console.error(e);
  } finally {
    setBusy(visualList, false);
  }
}

// ============================
// 投票者集計
// ============================
async function loadVoteCheck() {
  setBusy(voteCheckBody, true);
  voteCheckBody.innerHTML = '';
  checkMeta.textContent = '';

  try {
    const d = await withTimeout(async (signal) => {
      const r = await fetch(`${window.GAS_API_URL}?type=vote_check`, {
        signal,
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    if (!d?.ok) throw new Error(d?.error || 'vote_check failed');

    const members = Array.isArray(d.members) ? d.members : [];
    const scoresSet = new Set(
      (d.scoresNicknames || [])
        .map((x) => String(x || '').trim())
        .filter(Boolean),
    );
    const visualSet = new Set(
      (d.visualNicknames || [])
        .map((x) => String(x || '').trim())
        .filter(Boolean),
    );

    let doneScores = 0;
    let doneVisual = 0;

    const frag = document.createDocumentFragment();

    members.forEach((nameRaw) => {
      const name = String(nameRaw || '').trim();
      if (!name) return;

      const hasScores = scoresSet.has(name);
      const hasVisual = visualSet.has(name);
      if (hasScores) doneScores++;
      if (hasVisual) doneVisual++;

      const tr = document.createElement('tr');
      tr.className = hasScores && hasVisual ? 'check-ok' : 'check-ng';

      tr.innerHTML = `
        <td>${esc(name)}</td>
        <td>${hasScores ? '〇' : ''}</td>
        <td>${hasVisual ? '〇' : ''}</td>
      `;
      frag.appendChild(tr);
    });

    voteCheckBody.appendChild(frag);

    const updatedAt = d.updatedAt
      ? `最終更新：${new Date(d.updatedAt).toLocaleString()}`
      : '';
    checkMeta.textContent =
      `参加者 ${members.length}名 / 合計点 ${doneScores}名 / ビジュアル ${doneVisual}名` +
      (updatedAt ? `　｜　${updatedAt}` : '');
  } catch (e) {
    voteCheckBody.innerHTML = `<tr><td colspan="3">取得に失敗しました</td></tr>`;
    console.error(e);
  } finally {
    setBusy(voteCheckBody, false);
  }
}

function renderVisualList(items) {
  const arr = Array.isArray(items) ? [...items] : [];
  arr.sort(
    (a, b) =>
      (b?.votes ?? 0) - (a?.votes ?? 0) ||
      String(a.name).localeCompare(String(b.name)),
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
          it.name || `No.${i + 1}`,
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
// 起動
// ============================
function bindEvents() {
  refreshStatsBtn?.addEventListener('click', () => loadStats(true));
  refreshVisualBtn?.addEventListener('click', () => loadVisual(true));
  refreshCheckBtn?.addEventListener('click', () => loadVoteCheck(true));
  toggleBtn?.addEventListener('click', toggleVoteOpen);
}

async function init() {
  bindEvents();

  // 受付状態は即開始（待たない）
  loadVoteOpen();

  // 3つは並列で取得（最遅の1本だけ待つ）
  await Promise.allSettled([loadStats(), loadVisual(), loadVoteCheck()]);
}

init();
