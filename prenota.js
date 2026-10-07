(() => {
  'use strict';

  // Recupera lo slug dell'evento e credenziali Supabase dall'URL o da localStorage/window
  const urlParams = new URLSearchParams(window.location.search);
  const eventSlug = urlParams.get('evento') || 'demo-giornata-benessere';

  // Recupera credenziali salvate in localStorage / settings nell'app
  let localUrl = localStorage.getItem('mauro_wellness_supabase_url') || '';
  let localKey = localStorage.getItem('mauro_wellness_supabase_key') || '';

  if (!localUrl || !localKey) {
    try {
      const rawSettings = localStorage.getItem('mauro_wellness_settings_v1');
      if (rawSettings) {
        const parsed = JSON.parse(rawSettings);
        if (!localUrl && parsed.supabaseUrl) localUrl = parsed.supabaseUrl;
        if (!localKey && parsed.supabaseAnonKey) localKey = parsed.supabaseAnonKey;
      }
    } catch (_) {}
  }

  // Configurazione Supabase: priorità a parametri URL, poi credenziali locali, poi window (config.js) per il primo accesso cliente
  let SUPABASE_URL = urlParams.get('sb_url') || localUrl || (window.SUPABASE_URL && window.SUPABASE_URL.trim() ? window.SUPABASE_URL.trim() : '');
  let SUPABASE_ANON_KEY = urlParams.get('sb_key') || localKey || (window.SUPABASE_ANON_KEY && window.SUPABASE_ANON_KEY.trim() ? window.SUPABASE_ANON_KEY.trim() : '');

  if (urlParams.get('sb_url')) {
    try { localStorage.setItem('mauro_wellness_supabase_url', urlParams.get('sb_url')); } catch (_) {}
  }
  if (urlParams.get('sb_key')) {
    try { localStorage.setItem('mauro_wellness_supabase_key', urlParams.get('sb_key')); } catch (_) {}
  }

  let currentEvent = null;
  let bookedSlots = [];
  let selectedSlot = null;

  function showAlert(msg, isError = true) {
    const el = document.getElementById('statusAlert');
    if (!el) return;
    el.textContent = msg;
    el.className = `alert ${isError ? 'error' : 'success'}`;
    el.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function hideAlert() {
    const el = document.getElementById('statusAlert');
    if (el) el.style.display = 'none';
  }

  // Chiamata API generica verso Supabase RPC
  async function callSupabaseRpc(functionName, params = {}) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return mockSupabaseRpc(functionName, params);
    }

    try {
      const cleanUrl = SUPABASE_URL.replace(/\/+$/, '');
      const response = await fetch(`${cleanUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify(params)
      });

      if (!response.ok) {
        let errMessage = `Errore HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson && errJson.message) errMessage = errJson.message;
          else if (errJson && errJson.hint) errMessage = errJson.hint;
        } catch (_) {
          const errText = await response.text();
          if (errText) errMessage = errText;
        }

        if (response.status === 404) {
          errMessage = `Giornata Benessere o servizio non raggiungibile. Verifica l'URL dell'evento.`;
        }

        return { success: false, message: `Errore Supabase (${response.status}): ${errMessage}` };
      }

      return await response.json();
    } catch (err) {
      console.warn('Errore di comunicazione con Supabase:', err.message);
      return { success: false, message: `Impossibile collegarsi al server di prenotazione: ${err.message}` };
    }
  }

  // Fallback / Mock isolato per test del prototipo locale senza connessione Supabase
  function mockSupabaseRpc(functionName, params) {
    const mockStorageKey = 'mauro_wellness_mock_db_v1';
    let db = JSON.parse(localStorage.getItem(mockStorageKey) || '{}');

    if (!db.events) {
      db.events = {
        'demo-giornata-benessere': {
          id: 'evt-demo-1',
          slug: 'demo-giornata-benessere',
          nome_centro: 'Centro Sportivo Olimpia',
          data_evento: '2026-10-15',
          note: 'Giornata promozionale massaggi decontratturanti e sportivi. Presentarsi 5 minuti prima dell\'orario.',
          tariffa_iscritti: 45.00,
          tariffa_non_iscritti: 50.00,
          stato: 'aperto',
          luogo_evento: '',
          orari: [
            "09:00 - 10:00",
            "10:15 - 11:15",
            "11:30 - 12:30",
            "14:00 - 15:00",
            "15:15 - 16:15",
            "16:30 - 17:30",
            "17:45 - 18:45"
          ]
        }
      };
      db.bookings = db.bookings || [];
      localStorage.setItem(mockStorageKey, JSON.stringify(db));
    }

    if (functionName === 'get_public_event_slots') {
      const evt = db.events[params.p_slug];
      if (!evt) return { success: false, message: 'Giornata Benessere non trovata.' };

      const activeBookings = (db.bookings || [])
        .filter(b => b.event_id === evt.id && b.stato !== 'annullata')
        .map(b => b.orario);

      return {
        success: true,
        event: evt,
        booked_slots: activeBookings
      };
    }

    if (functionName === 'book_slot') {
      const evt = db.events[params.p_slug];
      if (!evt) return { success: false, message: 'Giornata Benessere non trovata.' };
      if (evt.stato !== 'aperto') return { success: false, message: 'Le prenotazioni per questo evento sono chiuse.' };

      const existing = (db.bookings || []).find(b => b.event_id === evt.id && b.orario === params.p_orario && b.stato !== 'annullata');
      if (existing) {
        return { success: false, message: `L'orario selezionato (${params.p_orario}) è appena stato prenotato da un altro utente. Scegli un altro orario disponibile.` };
      }

      const tariffa = params.p_is_iscritto ? evt.tariffa_iscritti : evt.tariffa_non_iscritti;
      const newBooking = {
        id: 'b-' + Date.now(),
        event_id: evt.id,
        orario: params.p_orario,
        nome: params.p_nome,
        cognome: params.p_cognome,
        telefono: params.p_telefono,
        email: params.p_email,
        is_iscritto: params.p_is_iscritto,
        consenso_promozionale: Boolean(params.p_consenso_promozionale),
        tariffa_applicata: tariffa,
        stato: 'confermata',
        stato_pagamento: 'Da pagare',
        created_at: new Date().toISOString()
      };

      db.bookings.push(newBooking);
      localStorage.setItem(mockStorageKey, JSON.stringify(db));

      return {
        success: true,
        booking_id: newBooking.id,
        message: 'Prenotazione confermata con successo!',
        details: {
          nome_centro: evt.nome_centro,
          data_evento: evt.data_evento,
          orario: params.p_orario,
          tariffa: tariffa,
          stato_pagamento: 'Da pagare'
        }
      };
    }

    return { success: false, message: 'Funzione non supportata.' };
  }

  function formatDate(isoStr) {
    if (!isoStr) return '';
    const parts = isoStr.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return isoStr;
  }

  async function loadEventData() {
    hideAlert();
    const res = await callSupabaseRpc('get_public_event_slots', { p_slug: eventSlug });

    document.getElementById('loadingView').style.display = 'none';

    if (!res || !res.success) {
      showAlert(res?.message || 'Impossibile caricare le informazioni sulla Giornata Benessere.', true);
      return;
    }

    currentEvent = res.event;
    bookedSlots = res.booked_slots || [];

    document.getElementById('eventTitle').textContent = currentEvent.nome_centro;
    document.getElementById('eventSubtitle').textContent = `Giornata Benessere — ${formatDate(currentEvent.data_evento)}`;
    document.getElementById('eventDateText').textContent = `📅 Data Evento: ${formatDate(currentEvent.data_evento)}`;
    const locationEl = document.getElementById('eventLocationText');
    if (locationEl) {
      const location = String(currentEvent.luogo_evento || '').trim();
      locationEl.textContent = location ? `📍 presso ${location}` : '';
      locationEl.style.display = location ? 'block' : 'none';
    }
    document.getElementById('eventNotes').textContent = currentEvent.note || '';
    document.getElementById('priceMember').textContent = `€ ${Number(currentEvent.tariffa_iscritti).toFixed(2)}`;
    document.getElementById('priceNonMember').textContent = `€ ${Number(currentEvent.tariffa_non_iscritti).toFixed(2)}`;

    if (currentEvent.stato !== 'aperto') {
      document.getElementById('closedView').style.display = 'block';
      return;
    }

    document.getElementById('mainFormView').style.display = 'block';
    renderSlots();
  }

  function renderSlots() {
    const container = document.getElementById('slotsContainer');
    if (!container || !currentEvent || !Array.isArray(currentEvent.orari)) return;

    container.innerHTML = currentEvent.orari.map(time => {
      const isBooked = bookedSlots.includes(time);
      const isSelected = selectedSlot === time;
      const disabledAttr = isBooked ? 'disabled' : '';
      const selectedClass = isSelected ? 'selected' : '';

      return `<button type="button" class="slot-btn ${selectedClass}" ${disabledAttr} data-time="${time}">
        ${time} ${isBooked ? ' (Occupato)' : ''}
      </button>`;
    }).join('');

    container.querySelectorAll('.slot-btn:not([disabled])').forEach(btn => {
      btn.onclick = () => {
        selectedSlot = btn.dataset.time;
        renderSlots();
        validateForm();
      };
    });
  }

  function validateForm() {
    const submitBtn = document.getElementById('submitBtn');
    const nome = document.getElementById('inputNome')?.value.trim();
    const cognome = document.getElementById('inputCognome')?.value.trim();
    const telefono = document.getElementById('inputTelefono')?.value.trim();
    const email = document.getElementById('inputEmail')?.value.trim();
    const privacy = document.getElementById('checkPrivacy')?.checked;

    const isValid = Boolean(selectedSlot && nome && cognome && telefono && email && privacy);
    if (submitBtn) {
      submitBtn.disabled = !isValid;
    }
  }

  function initForm() {
    const inputs = ['inputNome', 'inputCognome', 'inputTelefono', 'inputEmail'];
    inputs.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = validateForm;
    });

    const checkPrivacy = document.getElementById('checkPrivacy');
    if (checkPrivacy) checkPrivacy.onchange = validateForm;

    const form = document.getElementById('bookingForm');
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        hideAlert();

        if (!selectedSlot) {
          showAlert('Seleziona un orario prima di procedere.', true);
          return;
        }

        const submitBtn = document.getElementById('submitBtn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Invio in corso...';

        const payload = {
          p_slug: eventSlug,
          p_orario: selectedSlot,
          p_nome: document.getElementById('inputNome').value.trim(),
          p_cognome: document.getElementById('inputCognome').value.trim(),
          p_telefono: document.getElementById('inputTelefono').value.trim(),
          p_email: document.getElementById('inputEmail').value.trim(),
          p_is_iscritto: document.getElementById('checkIscritto').checked,
          p_consenso_promozionale: document.getElementById('checkPromozionale').checked
        };

        const res = await callSupabaseRpc('book_slot', payload);

        if (!res || !res.success) {
          showAlert(res?.message || 'Errore durante la prenotazione. Riprova.', true);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Conferma Prenotazione';
          await loadEventData();
          return;
        }

        // Prenotazione riuscita
        document.getElementById('mainFormView').style.display = 'none';
        document.getElementById('successView').style.display = 'block';

        const summaryBox = document.getElementById('summaryBox');
        summaryBox.innerHTML = `
          <p style="margin-bottom:6px"><strong>Centro:</strong> ${res.details.nome_centro}</p>
          <p style="margin-bottom:6px"><strong>Data:</strong> ${formatDate(res.details.data_evento)}</p>
          <p style="margin-bottom:6px"><strong>Orario:</strong> <span style="color:var(--accent);font-weight:bold">${res.details.orario}</span></p>
          <p style="margin-bottom:6px"><strong>Cliente:</strong> ${payload.p_nome} ${payload.p_cognome}</p>
          <p style="margin-bottom:6px"><strong>Recapito:</strong> ${payload.p_telefono} — ${payload.p_email}</p>
          <p style="margin-bottom:6px"><strong>Tariffa calcolata:</strong> € ${Number(res.details.tariffa).toFixed(2)} (${payload.p_is_iscritto ? 'Iscritto' : 'Non iscritto'})</p>
          <p style="margin-bottom:0"><strong>Stato Pagamento:</strong> <span style="color:var(--danger)">${res.details.stato_pagamento || 'Da pagare'}</span> (Saldabile in sede)</p>
        `;
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initForm();
      loadEventData();
    });
  } else {
    initForm();
    loadEventData();
  }
})();
