// scripts/latest-result.js

// 要素参照
const rankingGridEl = document.getElementById('latest-ranking');
const statusEl = document.getElementById('latest-status');
const roundEl = document.getElementById('latest-round');
const designEl = document.getElementById('latest-design');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// TOP3の1件分のカードを生成
function createRankingCard(item) {
  const card = document.createElement('article');
  card.className = 'ranking-card';

  const rank = Number(item.rank) || 0;
  let medalClass = '';
  if (rank === 1) medalClass = 'ranking-card__medal--gold';
  else if (rank === 2) medalClass = 'ranking-card__medal--silver';
  else if (rank === 3) medalClass = 'ranking-card__medal--bronze';

  const sakeUrl = (item.sakeUrl || '').trim();
  const breweryUrl = (item.breweryUrl || '').trim();
  const imgUrl = (item.img || '').trim();

  // 写真（クリックで sakeUrl へ）
  const photoHtml = imgUrl
    ? `
      <div class="ranking-card__photo">
        ${
          sakeUrl
            ? `<a href="${esc(
                sakeUrl
              )}" target="_blank" rel="noopener noreferrer">
                 <img src="${esc(imgUrl)}" alt="${esc(item.name || '')}">
               </a>`
            : `<img src="${esc(imgUrl)}" alt="${esc(item.name || '')}">`
        }
      </div>
    `
    : '';

  // タイトル（クリックで sakeUrl へ）
  const titleHtml = sakeUrl
    ? `<a href="${esc(sakeUrl)}" target="_blank" rel="noopener noreferrer">
         ${esc(item.name || '')}
       </a>`
    : esc(item.name || '');

  // 酒蔵名（クリックで breweryUrl へ）
  const breweryText =
    esc(item.brewery || '') +
    (item.prefName ? `（${esc(item.prefName)}）` : '');

  const breweryHtml = breweryUrl
    ? `<a href="${esc(breweryUrl)}" target="_blank" rel="noopener noreferrer">
         ${breweryText}
       </a>`
    : breweryText;

  card.innerHTML = `
    <div class="ranking-card__medal ${medalClass}">
      ${esc(rank)}位
    </div>
    <div>
      ${photoHtml}
      <div class="ranking-card__title">${titleHtml}</div>
      <div class="ranking-card__brewery">${breweryHtml}</div>
      <div class="ranking-card__meta">
        ${item.totalScore ? `総合得点：${esc(item.totalScore)}点` : ''}
        ${
          item.awardLabel
            ? (item.totalScore ? '／' : '') + esc(item.awardLabel)
            : ''
        }
      </div>
    </div>
  `;

  return card;
}

// ボトルデザイン賞のカードを生成
function createDesignCard(item) {
  const card = document.createElement('article');
  card.className = 'ranking-card ranking-card--design';

  const breweryUrl = (item.breweryUrl || '').trim();
  const imgUrl = (item.img || '').trim();

  const photoHtml = imgUrl
    ? `
      <div class="ranking-card__photo">
        ${
          breweryUrl
            ? `<a href="${esc(
                breweryUrl
              )}" target="_blank" rel="noopener noreferrer">
                 <img src="${esc(imgUrl)}" alt="${esc(item.name || '')}">
               </a>`
            : `<img src="${esc(imgUrl)}" alt="${esc(item.name || '')}">`
        }
      </div>
    `
    : '';

  const titleHtml = esc(item.name || '');

  const breweryText =
    esc(item.brewery || '') +
    (item.prefName ? `（${esc(item.prefName)}）` : '');

  const breweryHtml = breweryUrl
    ? `<a href="${esc(breweryUrl)}" target="_blank" rel="noopener noreferrer">
         ${breweryText}
       </a>`
    : breweryText;

  card.innerHTML = `
    <div class="ranking-card__medal ranking-card__medal--design">
      ${esc(item.awardLabel || 'ボトルデザイン賞')}
    </div>
    <div>
      ${photoHtml}
      <div class="ranking-card__title">${titleHtml}</div>
      <div class="ranking-card__brewery">${breweryHtml}</div>
    </div>
  `;

  return card;
}

async function fetchLatestResult() {
  if (!rankingGridEl || !statusEl) return;

  try {
    statusEl.textContent = '最新の結果を読み込んでいます…';

    const res = await fetch(
      `${window.SAKE_MASTER_API_URL}?type=latest_ranking`,
      { cache: 'no-store' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'API error');

    const event = data.event || {};
    const top3 = Array.isArray(data.top3) ? data.top3 : [];

    // 「第◯回」の◯を書き換え
    if (roundEl && (event.round || event.round === 0)) {
      roundEl.textContent = esc(event.round);
    }

    // ランキング表示
    rankingGridEl.innerHTML = '';

    if (!top3.length) {
      statusEl.textContent = '最新回の結果がまだ登録されていません。';
      rankingGridEl.appendChild(statusEl);
      return;
    }

    const frag = document.createDocumentFragment();
    top3.forEach((item) => {
      frag.appendChild(createRankingCard(item));
    });

    rankingGridEl.appendChild(frag);
    // ステータスメッセージは不要なので削除
    statusEl.remove();

    // ★ ボトルデザイン賞を描画
    if (designEl && data.designAward) {
      designEl.innerHTML = '';
      designEl.appendChild(createDesignCard(data.designAward));
    }
  } catch (e) {
    console.error(e);
    statusEl.textContent =
      '最新の結果の取得に失敗しました。時間をおいて再度お試しください。';
  }
}

document.addEventListener('DOMContentLoaded', fetchLatestResult);
