// Served as a same-origin asset. Credentials never leave memory or enter URLs/storage.
export const creditDashboardScript = String.raw`(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const number = new Intl.NumberFormat('pt-BR');
  let credentials = null, timer = null, controller = null, generation = 0;
  let page = 1, size = 20, total = 0, items = [], fingerprints = new Map();
  let connected = false, busy = false, paused = false;
  const identity = item => JSON.stringify([item.name, item.email, item.phoneNumber, item.birthDate, item.taxNumber]);
  const fingerprint = records => {
    const result = new Map();
    records.forEach(item => { const key = identity(item); result.set(key, (result.get(key) || 0) + 1); });
    return result;
  };
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function message(text, error = false, latest = false) {
    byId('message').hidden = !text;
    byId('message').className = error ? 'banner error' : 'banner';
    byId('message-text').textContent = text;
    byId('go-latest').hidden = !latest;
  }
  function controls() {
    byId('refresh').disabled = busy;
    byId('page-size').disabled = busy;
    byId('previous').disabled = busy || page <= 1;
    byId('next').disabled = busy || page >= Math.max(1, Math.ceil(total / size));
    byId('page-label').textContent = 'Página ' + page + ' de ' + Math.max(1, Math.ceil(total / size));
  }
  function showState(title, description) {
    byId('table-state').hidden = false;
    byId('state-title').textContent = title;
    byId('state-description').textContent = description;
  }
  function dateLabel(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Não informado';
    return value.slice(8, 10) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4);
  }
  function render(highlight = new Map()) {
    const tbody = byId('rows');
    tbody.replaceChildren();
    const query = byId('search').value.trim().toLocaleLowerCase('pt-BR');
    const visible = items.filter(item => [item.name,item.email,item.phoneNumber,item.birthDate,dateLabel(item.birthDate),item.taxNumber].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query)));
    const available = new Map(highlight);
    for (const item of visible) {
      const row = document.createElement('tr');
      const key = identity(item), count = available.get(key) || 0;
      if (count > 0) { row.className = 'fresh'; available.set(key, count - 1); }
      const name = document.createElement('td'), person = document.createElement('div'); person.className = 'person';
      const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden','true');
      const words = String(item.name || '').trim().split(/\s+/).filter(Boolean);
      avatar.textContent = words.length ? (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toLocaleUpperCase('pt-BR') : '—';
      const label = document.createElement('span'); label.className = 'person-name'; label.textContent = item.name || 'Não informado';
      person.append(avatar,label); name.append(person); row.append(name);
      for (const [value, className] of [[item.email,'email'],[item.phoneNumber,'phone'],[dateLabel(item.birthDate),'birth'],[item.taxNumber,'tax']]) {
        const cell = document.createElement('td'); cell.className = className; cell.textContent = value || 'Não informado'; row.append(cell);
      }
      tbody.append(row);
    }
    byId('visible').textContent = number.format(visible.length);
    byId('total').textContent = number.format(total);
    byId('table-state').hidden = visible.length > 0;
    if (!visible.length) {
      if (query) showState('Nenhum contato encontrado', 'A busca considera apenas os contatos desta página.');
      else showState('Nenhum lead por aqui ainda', 'Os contatos aparecerão automaticamente após a captura.');
    }
    const start = total ? (page - 1) * size + 1 : 0, end = Math.min(page * size,total);
    byId('range').textContent = query ? visible.length + ' resultado(s) nesta página' : number.format(start) + '–' + number.format(end) + ' de ' + number.format(total) + (total === 1 ? ' lead' : ' leads');
    controls();
  }
  function schedule(delay = 5000) {
    clearTimer();
    if (credentials && !paused && !document.hidden) timer = setTimeout(() => load(), delay);
  }
  function disconnect(reason = '') {
    generation++; clearTimer(); controller?.abort(); controller = null;
    credentials = null; connected = false; busy = false; paused = false;
    items = []; total = 0; page = 1; fingerprints.clear();
    byId('api-key').value = ''; byId('search').value = '';
    byId('rows').replaceChildren(); byId('total').textContent = '—'; byId('visible').textContent = '—';
    byId('dashboard').hidden = true; byId('access').hidden = false; byId('logout').hidden = true;
    byId('connection').dataset.connected = 'false'; byId('connection-label').textContent = 'Acesso protegido';
    byId('login-button').disabled = false; byId('login-button').textContent = 'Conectar e visualizar';
    byId('login-error').hidden = !reason; byId('login-error').textContent = reason;
    byId('last-sync').textContent = 'Aguardando primeira consulta'; message(''); controls();
    byId('client-id').focus();
  }
  function validatePage(data) {
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== page || data.pageSize !== size || data.items.length > size) throw new Error('response');
    return data.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('response');
      const contact = {};
      for (const field of ['name','email','phoneNumber','birthDate','taxNumber']) {
        if (item[field] !== null && typeof item[field] !== 'string') throw new Error('response');
        contact[field] = item[field];
      }
      return contact;
    });
  }
  async function load({ navigation = false } = {}) {
    if (!credentials || busy) return;
    clearTimer(); busy = true; controls();
    const token = generation;
    const requestController = new AbortController(); controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 15000);
    let retryDelay = 5000;
    try {
      const response = await fetch('/api/credit-leads?page=' + page + '&page_size=' + size, {
        method:'GET', credentials:'omit', cache:'no-store', redirect:'error',
        headers:{'X-Client-Id':credentials.id,'X-API-Key':credentials.key}, signal:requestController.signal
      });
      if (token !== generation) return;
      if (response.status === 401 || response.status === 403) {
        disconnect(response.status === 401 ? 'Credencial não reconhecida. Confira o client ID e a API key.' : 'Esta credencial não tem permissão de leitura. Solicite uma chave com escopo read.');
        return;
      }
      if (response.status === 503 || response.status === 429) {
        const header = response.headers.get('Retry-After');
        const wait = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header || '') - Date.now();
        retryDelay = Math.max(10000, Number.isFinite(wait) ? wait : 10000);
      }
      if (!response.ok) throw new Error('http');
      const data = await response.json();
      if (token !== generation) return;
      const records = validatePage(data);
      const pages = Math.max(1, Math.ceil(data.total / size));
      if (page > pages) {
        page = pages; fingerprints.clear(); items = []; total = data.total; render(); retryDelay = 0;
        return;
      }
      const previousTotal = total, previous = fingerprints;
      const wasConnected = connected;
      total = data.total; items = records;
      const next = fingerprint(items), added = new Map();
      if (wasConnected && !navigation) for (const [key,count] of next) {
        const difference = count - (previous.get(key) || 0); if (difference > 0) added.set(key, difference);
      }
      fingerprints = next;
      connected = true; paused = false;
      byId('api-key').value = '';
      byId('access').hidden = true; byId('dashboard').hidden = false; byId('logout').hidden = false;
      byId('connection').dataset.connected = 'true'; byId('connection-label').textContent = 'Conectado';
      byId('sync-title').textContent = 'A cada 5 segundos';
      byId('last-sync').textContent = 'Última consulta às ' + new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
      render(added);
      const increase = total - previousTotal;
      if (wasConnected && !navigation && increase > 0) {
        const text = increase === 1 ? 'Um novo lead está disponível na listagem.' : number.format(increase) + ' novos leads estão disponíveis na listagem.';
        message(text, false, page > 1); byId('announcement').textContent = text;
      } else message('');
    } catch (error) {
      if (token !== generation) return;
      if (!connected) {
        credentials = null;
        byId('login-error').textContent = 'Não foi possível consultar os leads. Verifique a conexão e tente novamente.';
        byId('login-error').hidden = false;
      } else {
        byId('sync-title').textContent = 'Reconectando…';
        byId('connection').dataset.connected = 'false'; byId('connection-label').textContent = 'Sem atualização';
        message('A atualização falhou. Os dados exibidos são da última consulta. Uma nova tentativa será feita automaticamente.', true);
      }
    } finally {
      clearTimeout(timeout);
      if (token === generation) {
        busy = false; controller = null; controls();
        byId('login-button').disabled = false; byId('login-button').textContent = 'Conectar e visualizar';
        schedule(retryDelay);
      }
    }
  }
  byId('login-form').addEventListener('submit', event => {
    event.preventDefault(); if (busy) return;
    const id = byId('client-id').value.trim(), key = byId('api-key').value.trim();
    if (!id || !key) return;
    generation++; credentials = {id,key}; page = 1; total = 0; fingerprints.clear();
    byId('login-error').hidden = true; byId('login-button').disabled = true; byId('login-button').textContent = 'Conectando…';
    load();
  });
  byId('logout').addEventListener('click', () => disconnect());
  byId('refresh').addEventListener('click', () => { paused = false; load(); });
  byId('search').addEventListener('input', () => render());
  byId('previous').addEventListener('click', () => { if (busy || page <= 1) return; page--; load({navigation:true}); });
  byId('next').addEventListener('click', () => { if (busy || page >= Math.ceil(total / size)) return; page++; load({navigation:true}); });
  byId('go-latest').addEventListener('click', () => { if (busy) return; page = 1; load({navigation:true}); });
  byId('page-size').addEventListener('change', () => { if (busy) return; size = Number(byId('page-size').value); page = 1; load({navigation:true}); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimer(); if (connected) byId('sync-title').textContent = 'Pausada nesta aba'; }
    else if (credentials) { paused = false; load(); }
  });
  window.addEventListener('pagehide', () => disconnect());
})();`;
