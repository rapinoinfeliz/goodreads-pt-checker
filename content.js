/**
 * Goodreads PT Edition Checker — content.js
 *
 * Content script que roda em páginas de livro do Goodreads.
 * Substitui o botão "Buy on Amazon" por um badge indicando
 * se existe edição em português. Ao clicar no badge, abre um
 * painel flutuante com todas as edições, capas e ISBNs.
 *
 * Fluxo:
 * 1. Encontra o botão "Buy on Amazon" na página
 * 2. Substitui por um badge de "carregando"
 * 3. Extrai o work_id do DOM da página
 * 4. Faz fetch da página de edições filtrada por português (same-origin)
 * 5. Parseia o HTML para extrair edições, ISBNs e URLs de capa
 * 6. Atualiza o badge com o resultado
 * 7. Ao clicar no badge, abre painel flutuante com detalhes
 */

(async function () {
  'use strict';

  // ── Variáveis de estado global ────────────────────────────────
  const STORAGE_KEY = 'grpt_found_books';
  let foundEditions = [];
  let editionsPageUrl = '';
  let currentPathname = window.location.pathname;
  let isChecking = false;

  // Cache para tooltips
  let bookCache = new Map(); // bookId -> { status, editions, workId }

  // Fila de fetches para tooltips com controle de concorrência
  const fetchQueue = {
    MAX_CONCURRENT: 3,
    active: 0,
    pending: [],
    queued: new Set(), // bookIds já na fila para evitar duplicatas
    enqueue(bookId, container, activeSpan) {
      if (this.queued.has(bookId)) return;
      this.queued.add(bookId);
      this.pending.push({ bookId, container, activeSpan });
      this._drain();
    },
    async _drain() {
      while (this.active < this.MAX_CONCURRENT && this.pending.length > 0) {
        const job = this.pending.shift();
        this.active++;
        fetchEditionsForTooltip(job.bookId, job.container, job.activeSpan)
          .finally(() => {
            this.active--;
            this.queued.delete(job.bookId);
            this._drain();
          });
      }
    }
  };

  function loadPersistedBooks() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        const now = Date.now();
        for (const [key, val] of Object.entries(parsed)) {
          if (val.status === 'not-found') {
            // TTL de 7 dias (7 * 24 * 60 * 60 * 1000)
            if (!val.timestamp || now - val.timestamp > 604800000) {
              continue; // Expirou
            }
          }
          bookCache.set(key, val);
        }
      }
    } catch (e) {
      console.error('[Goodreads PT] Erro ao carregar cache persistente:', e);
    }
  }

  function persistBookIfFound(bookId, cacheData) {
    if (cacheData.status === 'found' || cacheData.status === 'not-found') {
      try {
        const data = localStorage.getItem(STORAGE_KEY);
        const parsed = data ? JSON.parse(data) : {};
        cacheData.timestamp = Date.now();
        parsed[bookId] = cacheData;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      } catch (e) {
        console.error('[Goodreads PT] Erro ao salvar cache persistente:', e);
      }
    }
  }

  // Carrega os livros já encontrados do localStorage ao iniciar
  loadPersistedBooks();

  // ── 1. Encontrar o botão "Buy on Amazon" ─────────────────────

  function findAmazonButton() {
    // Procurar por botão ou link que tenha "Amazon" no aria-label ou no texto
    const candidates = document.querySelectorAll('button, a');
    for (const el of candidates) {
      const text = el.textContent.trim().toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      
      if (text.includes('amazon') || ariaLabel.includes('amazon')) {
        const group = el.closest('[class*="ButtonGroup"], [class*="buyButton"], [class*="BookActions__button"]');
        return group || el.parentElement;
      }
    }

    // Fallback: TreeWalker para texto puro "Amazon"
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: (node) =>
        node.textContent.toLowerCase().includes('amazon') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      }
    );
    const textNode = walker.nextNode();
    if (textNode) {
      const el = textNode.parentElement;
      const group = el.closest('[class*="ButtonGroup"], [class*="buyButton"], [class*="BookActions__button"]');
      return group || el.parentElement;
    }

    return null;
  }

  // ── 2. Extração do work_id ────────────────────────────────────

  function extractWorkId(doc = document, bodyHtml = document.body.innerHTML) {
    const editionsLinks = doc.querySelectorAll('a[href*="/work/editions/"]');
    for (const link of editionsLinks) {
      const match = link.href.match(/\/work\/editions\/(\d+)/);
      if (match) return match[1];
    }

    const workLinks = doc.querySelectorAll('a[href*="/work/"]');
    for (const link of workLinks) {
      const match = link.href.match(/\/work\/(\d+)/);
      if (match) return match[1];
    }

    const regexMatch = bodyHtml.match(/\/work\/editions\/(\d+)/);
    if (regexMatch) return regexMatch[1];

    const workRegex = bodyHtml.match(/work[_\-]?id["\s:=]+(\d+)/i);
    if (workRegex) return workRegex[1];

    return null;
  }

  // ── 3. Parsing da página de edições ───────────────────────────


  // ── 4. Badge ──────────────────────────────────────────────────

  function createBadge(state, editions) {
    const badge = document.createElement('div');
    badge.className = 'grpt-badge';

    if (state === 'loading') {
      badge.classList.add('grpt-loading');
      badge.innerHTML = `
        <span class="grpt-spinner"></span>
        <span class="grpt-text">Buscando edição PT…</span>
      `;
      return badge;
    }

    if (state === 'error') {
      badge.classList.add('grpt-error');
      badge.innerHTML = `
        <span class="grpt-icon">⚠️</span>
        <span class="grpt-text">Erro ao buscar edição PT</span>
      `;
      return badge;
    }

    if (state === 'not-found') {
      badge.classList.add('grpt-not-found');
      badge.innerHTML = `
        <span class="grpt-icon">✗</span>
        <span class="grpt-text">Sem edição em português</span>
      `;
      return badge;
    }

    // state === 'found'
    const count = editions.length;
    badge.classList.add('grpt-found');
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('title', 'Clique para ver edições em português');

    badge.innerHTML = `
      <span class="grpt-icon">🇧🇷</span>
      <span class="grpt-text">
        <span class="grpt-label">Edição PT disponível</span>
        <span class="grpt-isbn">${count} ${count !== 1 ? 'edições encontradas' : 'edição encontrada'}</span>
      </span>
      <span class="grpt-copy-hint">▾</span>
    `;

    // Click → abrir painel flutuante com as edições
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(badge);
    });

    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel(badge);
      }
    });

    return badge;
  }

  // ── 5. Painel flutuante ───────────────────────────────────────

  function togglePanel(badge) {
    const existing = document.querySelector('.grpt-panel');
    if (existing) {
      existing.remove();
      document.querySelector('.grpt-overlay')?.remove();
      return;
    }
    openPanel(badge);
  }

  function openPanel(badge) {
    const overlay = document.createElement('div');
    overlay.className = 'grpt-overlay';

    const escHandler = (e) => {
      if (e.key === 'Escape') closePanel();
    };
    
    function closePanel() {
      const p = document.querySelector('.grpt-panel');
      if (p) p.remove();
      const o = document.querySelector('.grpt-overlay');
      if (o) o.remove();
      window.removeEventListener('scroll', closePanel);
      window.removeEventListener('resize', closePanel);
      document.removeEventListener('click', outsideClickListener);
      document.removeEventListener('keydown', escHandler);
    }

    function outsideClickListener(e) {
      const panel = document.querySelector('.grpt-panel');
      if (panel && !panel.contains(e.target) && !e.target.closest('.grpt-badge')) {
        closePanel();
      }
    }

    document.addEventListener('click', outsideClickListener);
    document.addEventListener('keydown', escHandler);
    window.addEventListener('scroll', closePanel, { passive: true });
    window.addEventListener('resize', closePanel, { passive: true });
    overlay.addEventListener('click', closePanel);

    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.className = 'grpt-panel';

    const header = document.createElement('div');
    header.className = 'grpt-panel-header';
    header.innerHTML = `
      <div class="grpt-panel-title">
        <span>🇧🇷</span>
        <span>Edições em Português</span>
        <span class="grpt-panel-count">${foundEditions.length}</span>
      </div>
      <button class="grpt-panel-close" title="Fechar">✕</button>
    `;
    header.querySelector('.grpt-panel-close').addEventListener('click', closePanel);
    panel.appendChild(header);

    // Lista de edições
    const list = document.createElement('div');
    list.className = 'grpt-panel-list';

    for (const edition of foundEditions) {
      const item = document.createElement('div');
      item.className = 'grpt-panel-item';

      // Capa
      const coverDiv = document.createElement('div');
      coverDiv.className = 'grpt-panel-cover';
      if (edition.cover) {
        const img = document.createElement('img');
        img.src = edition.cover;
        img.alt = edition.title;
        img.loading = 'lazy';
        // Fallback se a imagem falhar
        img.addEventListener('error', () => {
          img.remove();
          coverDiv.innerHTML = '<span class="grpt-panel-no-cover">📕</span>';
        });
        coverDiv.appendChild(img);
      } else {
        coverDiv.innerHTML = '<span class="grpt-panel-no-cover">📕</span>';
      }
      item.appendChild(coverDiv);

      // Info
      const info = document.createElement('div');
      info.className = 'grpt-panel-info';

      const titleEl = document.createElement('p');
      titleEl.className = 'grpt-panel-item-title';
      if (edition.url) {
        const link = document.createElement('a');
        link.href = edition.url;
        link.target = '_blank';
        link.textContent = edition.title;
        link.style.color = 'inherit';
        link.style.textDecoration = 'none';
        link.addEventListener('mouseenter', () => link.style.textDecoration = 'underline');
        link.addEventListener('mouseleave', () => link.style.textDecoration = 'none');
        titleEl.appendChild(link);
      } else {
        titleEl.textContent = edition.title;
      }
      info.appendChild(titleEl);

      if (edition.isbn13) {
        const isbnRow = document.createElement('div');
        isbnRow.className = 'grpt-panel-isbn-row';

        const isbnText = document.createElement('span');
        isbnText.className = 'grpt-panel-isbn';
        isbnText.textContent = `ISBN-13: ${edition.isbn13}`;
        isbnRow.appendChild(isbnText);

        const actionsRow = document.createElement('div');
        actionsRow.className = 'grpt-panel-actions-row';
        actionsRow.style.display = 'flex';
        actionsRow.style.gap = '8px';
        actionsRow.style.marginTop = '4px';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'grpt-panel-copy';
        copyBtn.textContent = '📋 Copiar ISBN';
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await copyISBN(copyBtn, edition.isbn13);
        });
        actionsRow.appendChild(copyBtn);

        const tgBtn = document.createElement('button');
        tgBtn.className = 'grpt-panel-copy';
        tgBtn.innerHTML = '✈️ Telegram';
        tgBtn.title = 'Copiar título e buscar no Telegram';
        tgBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const cleanTitle = edition.title.replace(/\s*\(.*?\)\s*$/, '').trim();
          await navigator.clipboard.writeText(cleanTitle);
          tgBtn.textContent = 'Copiado!';
          setTimeout(() => { tgBtn.innerHTML = '✈️ Telegram'; }, 2000);
          window.open('https://web.telegram.org/a/#-1001380278130', '_blank');
        });
        actionsRow.appendChild(tgBtn);

        info.appendChild(actionsRow);
      } else {
        const noIsbn = document.createElement('p');
        noIsbn.className = 'grpt-panel-no-isbn';
        noIsbn.textContent = 'ISBN não disponível';
        info.appendChild(noIsbn);

        const actionsRow = document.createElement('div');
        actionsRow.className = 'grpt-panel-actions-row';
        actionsRow.style.display = 'flex';
        actionsRow.style.gap = '8px';
        actionsRow.style.marginTop = '4px';

        const tgBtn = document.createElement('button');
        tgBtn.className = 'grpt-panel-copy';
        tgBtn.innerHTML = '✈️ Telegram';
        tgBtn.title = 'Copiar título e buscar no Telegram';
        tgBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const cleanTitle = edition.title.replace(/\s*\(.*?\)\s*$/, '').trim();
          await navigator.clipboard.writeText(cleanTitle);
          tgBtn.textContent = 'Copiado!';
          setTimeout(() => { tgBtn.innerHTML = '✈️ Telegram'; }, 2000);
          window.open('https://web.telegram.org/a/#-1001380278130', '_blank');
        });
        actionsRow.appendChild(tgBtn);

        info.appendChild(actionsRow);
      }

      if (edition.meta) {
        const metaEl = document.createElement('p');
        metaEl.className = 'grpt-panel-meta';
        metaEl.textContent = edition.meta;
        info.appendChild(metaEl);
      }

      item.appendChild(info);
      list.appendChild(item);
    }

    panel.appendChild(list);

    // Footer com link para página de edições
    if (editionsPageUrl) {
      const footer = document.createElement('div');
      footer.className = 'grpt-panel-footer';
      const link = document.createElement('a');
      link.href = editionsPageUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Ver todas as edições no Goodreads ↗';
      link.className = 'grpt-panel-link';
      footer.appendChild(link);
      panel.appendChild(footer);
    }

    // Posicionar o painel abaixo do badge
    document.body.appendChild(panel);
    positionPanel(panel, badge);
  }

  function positionPanel(panel, badge) {
    const rect = badge.getBoundingClientRect();
    const panelWidth = 360;
    const maxHeight = 420;

    // Posição preferida: abaixo e alinhado à esquerda do badge
    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX;

    // Ajustar se sair da tela pela direita
    if (left + panelWidth > window.innerWidth - 16) {
      left = window.innerWidth - panelWidth - 16 + window.scrollX;
    }

    // Ajustar se sair da tela por baixo — abrir acima do badge
    if (rect.bottom + maxHeight > window.innerHeight) {
      top = rect.top + window.scrollY - maxHeight - 8;
      if (top < window.scrollY) top = rect.bottom + window.scrollY + 8;
    }

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }

  // ── 6. Copiar ISBN ────────────────────────────────────────────

  async function copyISBN(button, isbn) {
    try {
      await navigator.clipboard.writeText(isbn);
    } catch (err) {
      console.error('[Goodreads PT] Erro ao copiar ISBN:', err);
    }
    const original = button.textContent;
    button.textContent = '✓ Copiado!';
    button.classList.add('grpt-panel-copy-done');
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove('grpt-panel-copy-done');
    }, 2000);
  }

  // ── 7. Fluxo principal ────────────────────────────────────────

  async function initExtension() {
    if (isChecking) return;

    // Só executar em páginas de livro
    if (!window.location.pathname.includes('/book/show/')) return;

    const existingBadge = document.querySelector('.grpt-badge');

    // Se o badge já existe E a URL não mudou, estamos prontos
    if (existingBadge && currentPathname === window.location.pathname) {
      return;
    }

    // Se a URL mudou (navegação SPA), resetar o estado
    if (currentPathname !== window.location.pathname) {
      currentPathname = window.location.pathname;
      if (existingBadge) existingBadge.remove();
      const existingPanel = document.querySelector('.grpt-panel');
      if (existingPanel) existingPanel.remove();
      foundEditions = [];
      editionsPageUrl = '';
    }

    const amazonContainer = findAmazonButton();
    if (!amazonContainer) {
      // Deixa para a próxima mutação do DOM
      return;
    }

    // Se já inserimos o badge ao lado deste container, aborta
    if (amazonContainer.parentElement && amazonContainer.parentElement.querySelector('.grpt-badge')) {
      return;
    }

    isChecking = true;

    // Em vez de replaceWith (que quebra o React), escondemos o original
    amazonContainer.style.display = 'none';

    // Inserir badge de loading
    let currentBadge = createBadge('loading');
    amazonContainer.parentNode.insertBefore(currentBadge, amazonContainer);

    const updateBadge = (newBadge) => {
      if (currentBadge.parentNode) {
        currentBadge.replaceWith(newBadge);
        currentBadge = newBadge;
      }
    };

    const bookIdMatch = window.location.pathname.match(/\/book\/show\/(\d+)/);
    const bookId = bookIdMatch ? bookIdMatch[1] : null;

    if (bookId && bookCache.has(bookId)) {
      const cached = bookCache.get(bookId);
      if (cached.status === 'found') {
        foundEditions = cached.editions;
        updateBadge(createBadge('found', foundEditions));
        isChecking = false;
        return;
      } else if (cached.status === 'not-found') {
        updateBadge(createBadge('not-found'));
        isChecking = false;
        return;
      }
    }

    try {
      const workId = extractWorkId();
      if (!workId) {
        updateBadge(createBadge('error'));
        console.error('[Goodreads PT] work_id não encontrado.');
        isChecking = false;
        return;
      }

      editionsPageUrl = `/work/editions/${workId}?utf8=%E2%9C%93&sort=num_ratings&filter_by_format=&filter_by_language=por`;

      const response = await fetch(editionsPageUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      foundEditions = parseEditions(html);

      const bookIdMatch = window.location.pathname.match(/\/book\/show\/(\d+)/);
      const bookId = bookIdMatch ? bookIdMatch[1] : null;

      if (foundEditions.length === 0) {
        if (bookId) {
          bookCache.set(bookId, { status: 'not-found', editions: [] });
        }
        updateBadge(createBadge('not-found'));
      } else {
        if (bookId) {
          const cacheData = { status: 'found', editions: foundEditions };
          bookCache.set(bookId, cacheData);
          persistBookIfFound(bookId, cacheData);
        }
        updateBadge(createBadge('found', foundEditions));
      }

    } catch (err) {
      console.error('[Goodreads PT] Erro:', err);
      updateBadge(createBadge('error'));
    }

    isChecking = false;
  }

  // ── 8. Lógica de Injeção no Tooltip (Listas e Prêmios) ────────

  function detectAndHandleTooltip() {
    // Buscar todos os elementos da sinopse (freeTextContainer) no DOM
    const freeTextSpans = Array.from(document.querySelectorAll('span[id^="freeTextContainer"]'));
    
    for (const activeSpan of freeTextSpans) {
      const container = activeSpan.closest('.prototip_StemWrapper, .tooltip, div[class*="tooltip" i], body');
      if (!container) continue;

      // Extrair o ID do livro a partir do link do título dentro do próprio tooltip
      const bookLink = container.querySelector('a[href*="/book/show/"]');
      if (!bookLink) continue;

      const match = bookLink.href.match(/\/book\/show\/(\d+)/);
      if (!match) continue;

      const bookId = match[1];

      if (!bookCache.has(bookId)) {
        fetchQueue.enqueue(bookId, container, activeSpan);
      } else {
        updateActiveTooltip(bookId, container, activeSpan);
      }
    }
  }

  async function fetchEditionsForTooltip(bookId, container, activeSpan) {
    bookCache.set(bookId, { status: 'loading', editions: [] });
    updateActiveTooltip(bookId, container, activeSpan);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      // 1. Obter a página principal do livro para extrair o work_id
      const bookUrl = `/book/show/${bookId}`;
      const bookRes = await fetch(bookUrl, { signal: controller.signal });
      if (!bookRes.ok) throw new Error('Falha ao buscar book page');
      const bookHtml = await bookRes.text();
      
      const fakeDoc = document.createElement('div');
      fakeDoc.innerHTML = bookHtml;
      const workId = extractWorkId(fakeDoc, bookHtml);

      if (!workId) {
        bookCache.set(bookId, { status: 'not-found', editions: [] });
        updateActiveTooltip(bookId, container, activeSpan);
        clearTimeout(timeoutId);
        return;
      }

      // 2. Buscar a página de edições
      const editionsUrl = `/work/editions/${workId}?utf8=%E2%9C%93&sort=num_ratings&filter_by_format=&filter_by_language=por`;
      const edRes = await fetch(editionsUrl, { signal: controller.signal });
      if (!edRes.ok) throw new Error('Falha ao buscar edições');
      const edHtml = await edRes.text();

      const editions = parseEditions(edHtml);

      const cacheData = { 
        status: editions.length > 0 ? 'found' : 'not-found', 
        editions 
      };
      
      bookCache.set(bookId, cacheData);
      persistBookIfFound(bookId, cacheData);

    } catch (err) {
      console.error('[Goodreads PT] Erro background fetch:', err);
      bookCache.set(bookId, { status: 'error', editions: [] });
    } finally {
      clearTimeout(timeoutId);
      updateActiveTooltip(bookId, container, activeSpan);
    }
  }

  function updateActiveTooltip(bookId, container, activeSpan) {
    if (!container || !activeSpan) return;

    const tooltip = activeSpan.parentElement;

    let badgeContainer = tooltip.querySelector('.grpt-tooltip-container');
    if (!badgeContainer) {
      badgeContainer = document.createElement('div');
      badgeContainer.className = 'grpt-tooltip-container';
      badgeContainer.style.marginBottom = '10px';
      badgeContainer.style.paddingBottom = '10px';
      badgeContainer.style.borderBottom = '1px solid #e8e8e8';
      badgeContainer.style.fontFamily = 'Lato, "Helvetica Neue", Helvetica, sans-serif';
      
      // Inserir logo ANTES do texto da sinopse
      tooltip.insertBefore(badgeContainer, activeSpan);
    }

    const data = bookCache.get(bookId);
    if (!data) return;

    let newHtml = '';
    if (data.status === 'loading') {
      newHtml = '<span style="color: #767676; font-size: 12px;">⏳ Buscando edição PT-BR...</span>';
    } else if (data.status === 'error') {
      newHtml = '<span style="color: #d13515; font-size: 12px;">⚠️ Demorou muito ou falhou a busca.</span>';
    } else if (data.status === 'not-found') {
      newHtml = '<span style="color: #e25950; font-size: 12px;">✗ Sem edição em português.</span>';
    } else if (data.status === 'found') {
      const ed = data.editions[0];
      newHtml = `
        <div style="display: flex; gap: 8px; align-items: flex-start; text-align: left;">
          <span style="font-size: 18px; line-height: 1;">🇧🇷</span>
          <div style="flex: 1;">
            <strong style="color: #00635d; display: block; margin-bottom: 2px; font-size: 13px;">Edição PT-BR Disponível!</strong>
            <span style="font-size: 12px; color: #333; font-weight: bold; display: block; margin-bottom: 2px;">${ed.title}</span>
            <span style="font-size: 11px; color: #767676; display: block;">${ed.meta || 'Informações adicionais indisponíveis'}</span>
          </div>
        </div>
      `;
    }

    if (badgeContainer.innerHTML !== newHtml) {
      badgeContainer.innerHTML = newHtml;
    }
  }

  // ── 9. Observador de Mutações ─────────────────────────────────
  const debouncedInit = debounce(() => {
    initExtension();
    detectAndHandleTooltip();
  }, 150);

  const observer = new MutationObserver((mutations) => {
    debouncedInit();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Executar imediatamente caso o DOM já esteja pronto
  initExtension();

})();
