// Shared by rehearsal and live draws. Integer tickets make staff odds exactly 1:2.
globalThis.HanjogoRaffle = (() => {
  const generation = v => Number(String(v ?? '').match(/\d+/)?.[0]) || null;
  const key = p => `${String(p?.name || '').replace(/\s+/g, '').toLowerCase()}|${generation(p?.generation) || ''}`;
  function roster(state, operating = []) {
    const people = new Map(), skipped = [];
    const payments = state.participantPayments || [];
    const active = new Set(payments.filter(p => ['paid', 'exempt'].includes(p.status)).map(key));
    const cancelled = new Set(payments.filter(p => p.status === 'cancelled' && !active.has(key(p))).map(key));
    function add(name, gen, role, staff = false) {
      name = String(name || '').trim(); gen = generation(gen);
      if (!name || !gen) { skipped.push(role); return; }
      const id = key({name, generation: gen});
      if (cancelled.has(id)) return;
      const p = people.get(id) || {name, generation: gen, roles: [], weight: 2};
      if (!p.roles.includes(role)) p.roles.push(role);
      if (staff) p.weight = 1;
      people.set(id, p);
    }
    payments.filter(p => ['paid', 'exempt'].includes(p.status)).forEach(p => add(p.name, p.generation, '참가자'));
    (state.committee || []).forEach(p => add(p.name, p.gen, '준비위원', true));
    operating.forEach(p => add(p.name, p.generation, '운영위원', true));
    (state.donations || []).filter(p => !/(취소|철회|불참)/.test(p.status || '')).forEach(p => add(p.name, p.generation, '후원'));
    (state.sponsors || []).filter(p => !/(취소|철회|불참)/.test(p.status || '')).forEach(p => {
      const m = String(p.name || '').match(/([^/]+?)\((\d+)\s*기\)/);
      if (m) add(m[1], m[2], '협찬'); else skipped.push('협찬');
    });
    return {entries: [...people.values()].sort((a,b) => a.generation-b.generation || a.name.localeCompare(b.name,'ko')), skipped};
  }
  function pool(state, operating, type, exclude = false) {
    const entries = roster(state, operating).entries;
    const weights = new Map(entries.map(p => [key(p), p.weight]));
    const source = type === 'story' ? (state.raffleCenter?.storyEntries || []).map(p => ({...p, generation: generation(p.generation), weight: weights.get(key(p)) || 2})) : entries;
    const previous = new Set((state.raffleCenter?.history || []).map(p => key(p.winner)));
    const seen = new Set();
    return source.filter(p => {const id = key(p); if (!p.name || !p.generation || seen.has(id) || (exclude && previous.has(id))) return false; seen.add(id); return true;});
  }
  function pick(entries, randomIndex) {
    if (!entries.length) return null;
    const total = entries.reduce((n,p) => n + (p.weight === 1 ? 1 : 2), 0);
    let ticket = randomIndex(total);
    if (!Number.isInteger(ticket) || ticket < 0 || ticket >= total) throw Error('invalid_ticket');
    for (const person of entries) {ticket -= person.weight === 1 ? 1 : 2; if (ticket < 0) return {...person};}
  }
  return {generation, key, roster, pool, pick};
})();
