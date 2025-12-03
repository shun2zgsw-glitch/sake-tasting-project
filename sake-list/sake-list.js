// 出品酒一覧 JS

let SAKE_ITEMS = [];
const listEl = document.getElementById('sake-list');
const statusEl = document.getElementById('sake-status');
const sortSelectEl = document.getElementById('sortKey');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

async function fetchSakeList() {
  try {
    statusEl.textContent = '出品酒リストを読み込んでいます…';
    const res = await fetch(`${window.SAKE_MASTER_API_URL}?type=sakes_list`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'API error');

    SAKE_ITEMS = Array.isArray(data.items) ? data.items : [];
    if (!SAKE_ITEMS.length) {
      statusEl.textContent = '公開中の出品酒はまだ登録されていません。';
      listEl.innerHTML = '';
      return;
    }

    renderList();
    statusEl.textContent = `${SAKE_ITEMS.length}件の出品酒が見つかりました。`;
  } catch (e) {
    console.error(e);
    statusEl.textContent =
      '出品酒リストの取得に失敗しました。時間をおいて再度お試しください。';
  }
}

function getSortedItems() {
  const sortKey = sortSelectEl.value;
  const items = SAKE_ITEMS.slice(); // コピー

  if (sortKey === 'nameKana') {
    items.sort((a, b) =>
      String(a.nameKana || a.name || '').localeCompare(
        String(b.nameKana || b.name || ''),
        'ja'
      )
    );
  } else if (sortKey === 'prefCode') {
    items.sort((a, b) => {
      const ac = Number(a.prefCode) || 0;
      const bc = Number(b.prefCode) || 0;
      if (ac !== bc) return ac - bc;
      return String(a.nameKana || '').localeCompare(
        String(b.nameKana || ''),
        'ja'
      );
    });
  } else if (sortKey === 'typeSortOrder') {
    items.sort((a, b) => {
      const at = Number(a.typeSortOrder) || 999;
      const bt = Number(b.typeSortOrder) || 999;
      if (at !== bt) return at - bt;
      return String(a.nameKana || '').localeCompare(
        String(b.nameKana || ''),
        'ja'
      );
    });
  }

  return items;
}

function resolveImageSrc(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//.test(s)) return s;
  // ルート相対/相対パスどちらでもOKにする
  return s.replace(/^\/+/, '');
}

function renderList() {
  const items = getSortedItems();
  listEl.innerHTML = '';

  const frag = document.createDocumentFragment();

  items.forEach((it) => {
    const card = document.createElement('article');
    card.className = 'sake-card';

    const imgSrc = resolveImageSrc(it.img);
    const hasAmazon = !!(it.amazonUrl || '').trim();
    const hasRakuten = !!(it.rakutenUrl || '').trim();

    const desc = String(it.desc || '');
    const shortDesc = desc.length > 80 ? desc.slice(0, 80) + '…' : desc;

    card.innerHTML = `
      ${
        imgSrc
          ? `<div class="sake-card__thumb-wrap">
               <img src="${esc(imgSrc)}" alt="${esc(
              it.name || ''
            )}" class="sake-card__thumb" loading="lazy" decoding="async">
             </div>`
          : ''
      }
      <div class="sake-card__body">
        <h2 class="sake-card__title">${esc(it.name || '')}</h2>

        <div class="sake-card__meta-top">
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
            it.type
              ? `<span class="pill pill--type">${esc(it.type)}</span>`
              : ''
          }
          ${
            it.prefName
              ? `<span class="pill pill--pref">${esc(it.prefName)}</span>`
              : ''
          }
          ${
            it.round
              ? `<span class="pill pill--round">第${esc(it.round)}回出品</span>`
              : ''
          }
        </div>

        <p class="sake-card__desc">
          <span class="sake-card__desc-short">${esc(shortDesc)}</span>
          ${
            desc.length > 80
              ? `<span class="sake-card__desc-full" hidden>${esc(desc)}</span>
                 <button type="button" class="sake-card__more-btn">続きを読む</button>`
              : ''
          }
        </p>

        ${
          hasAmazon || hasRakuten
            ? `<div class="sake-card__links">
                 ${
                   hasAmazon
                     ? `<a href="${esc(
                         it.amazonUrl
                       )}" class="btn-sm btn-amazon" target="_blank" rel="noopener noreferrer sponsored nofollow">Amazonで見る</a>`
                     : ''
                 }
                 ${
                   hasRakuten
                     ? `<a href="${esc(
                         it.rakutenUrl
                       )}" class="btn-sm btn-rakuten" target="_blank" rel="noopener noreferrer sponsored nofollow">楽天で見る</a>`
                     : ''
                 }
               </div>`
            : ''
        }
      </div>
    `;

    frag.appendChild(card);
  });

  listEl.appendChild(frag);
}

function onSortChange() {
  renderList();
}

function onListClick(e) {
  const btn = e.target.closest('.sake-card__more-btn');
  if (!btn) return;

  const card = btn.closest('.sake-card');
  if (!card) return;

  const shortEl = card.querySelector('.sake-card__desc-short');
  const fullEl = card.querySelector('.sake-card__desc-full');
  if (!shortEl || !fullEl) return;

  const isExpanded = !fullEl.hidden;
  if (isExpanded) {
    fullEl.hidden = true;
    btn.textContent = '続きを読む';
  } else {
    fullEl.hidden = false;
    btn.textContent = '閉じる';
  }
}

// 起動
document.addEventListener('DOMContentLoaded', () => {
  sortSelectEl.addEventListener('change', onSortChange);
  listEl.addEventListener('click', onListClick);
  fetchSakeList();
});
