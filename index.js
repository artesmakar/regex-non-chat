const MODULE = 'promptFieldRegex';
const FIELDS = {
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  persona: 'Persona',
};

const { eventSource, event_types } = SillyTavern.getContext();

// ================= Settings =================
function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  extensionSettings[MODULE] ??= { enabled: true, debug: false, rules: [] };
  extensionSettings[MODULE].rules ??= [];
  return extensionSettings[MODULE];
}
const save = () => SillyTavern.getContext().saveSettingsDebounced();

const newId = () => Math.random().toString(36).slice(2, 10);
const newRule = () => ({
  id: newId(),
  name: '',
  enabled: true,
  find: '',
  replace: '',
  fields: { description: true, personality: false, scenario: false, persona: false },
});

// ================= Regex engine =================
// "/pattern/flags" = regex; anything else = plain text (replace all)
function parseRegex(str) {
  const m = str.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
  if (m) return new RegExp(m[1], m[2]);
  return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

function rulesFor(field) {
  return getSettings().rules
    .filter(r => r.enabled && r.find && r.fields?.[field])
    .map(r => { try { return [parseRegex(r.find), r.replace ?? '']; } catch { return null; } })
    .filter(Boolean);
}

const applyRules = (text, rules) =>
  rules.reduce((t, [re, rep]) => t.replace(re, rep), text);

// ================= Field collection =================
function getCards(ctx) {
  if (ctx.groupId) {
    const group = ctx.groups.find(g => g.id === ctx.groupId);
    return (group?.members ?? [])
      .map(avatar => ctx.characters.find(c => c.avatar === avatar))
      .filter(Boolean);
  }
  const card = ctx.characters[ctx.characterId];
  return card ? [card] : [];
}

function getFieldTexts() {
  const ctx = SillyTavern.getContext();
  const out = [];
  for (const card of getCards(ctx)) {
    for (const field of ['description', 'personality', 'scenario']) {
      out.push({
        field,
        label: `${card.name} – ${FIELDS[field]}`,
        text: card[field],
        sub: t => ctx.substituteParams(t, undefined, card.name),
      });
    }
  }
  out.push({
    field: 'persona',
    label: `${ctx.name1} – Persona`,
    text: ctx.powerUserSettings?.persona_description,
    sub: t => ctx.substituteParams(t),
  });
  return out;
}

function getTargets() {
  const targets = [];
  for (const { field, label, text, sub } of getFieldTexts()) {
    const rules = rulesFor(field);
    if (!text || !rules.length) continue;
    const original = sub(text).trim();
    if (!original) continue;
    const edited = applyRules(original, rules);
    if (edited !== original) targets.push({ label, original, edited });
  }
  return targets;
}

function patch(text, targets, hits) {
  for (const { label, original, edited } of targets) {
    if (text.includes(original)) {
      text = text.split(original).join(edited);
      hits.add(label);
    }
  }
  return text;
}

// ================= Prompt hook =================
function onPromptReady(data) {
  const s = getSettings();
  if (!s.enabled) return;
  const targets = getTargets();
  if (!targets.length) return;
  const hits = new Set();

  for (const msg of data.chat) {
    if (typeof msg.content === 'string') {
      msg.content = patch(msg.content, targets, hits);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') part.text = patch(part.text, targets, hits);
      }
    }
  }

  if (s.debug && !data.dryRun) {
    const missed = targets.filter(t => !hits.has(t.label)).map(t => t.label);
    console.log('[Prompt Field Regex] patched:', [...hits]);
    if (missed.length) console.warn('[Prompt Field Regex] NOT found in prompt:', missed);
  }
}

// ================= UI =================
const PANEL_HTML = `
<div id="pfr_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Prompt Field Regex</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="pfr_enabled"><span>Enabled</span></label>
      <label class="checkbox_label"><input type="checkbox" id="pfr_debug"><span>Log to console (F12)</span></label>
      <div class="pfr-buttons">
        <div id="pfr_add" class="menu_button"><i class="fa-solid fa-plus"></i> Add rule</div>
        <div id="pfr_preview" class="menu_button"><i class="fa-solid fa-eye"></i> Preview</div>
        <div id="pfr_export" class="menu_button"><i class="fa-solid fa-file-export"></i> Export</div>
        <div id="pfr_import" class="menu_button"><i class="fa-solid fa-file-import"></i> Import</div>
        <input type="file" id="pfr_import_file" accept=".json" hidden>
      </div>
      <small class="pfr-hint">
        Find: <code>/pattern/flags</code> for regex (add <code>g</code> to replace all), or plain text.
        Replace supports <code>$1</code>, <code>$2</code>… Rules run top to bottom.
      </small>
      <div id="pfr_rules"></div>
    </div>
  </div>
</div>`;

const RULE_HTML = `
<div class="pfr-rule">
  <div class="pfr-row">
    <input type="checkbox" class="pfr-enabled" title="Enabled">
    <input type="text" class="text_pole pfr-name" placeholder="Rule name (optional)">
    <div class="menu_button pfr-up fa-solid fa-arrow-up" title="Move up"></div>
    <div class="menu_button pfr-down fa-solid fa-arrow-down" title="Move down"></div>
    <div class="menu_button pfr-del fa-solid fa-trash-can" title="Delete"></div>
  </div>
  <input type="text" class="text_pole pfr-find" placeholder="Find: /pattern/gi or plain text">
  <textarea class="text_pole pfr-replace" rows="2" placeholder="Replace with (empty = delete match)"></textarea>
  <div class="pfr-fields"></div>
</div>`;

function renderRules() {
  const s = getSettings();
  const $list = $('#pfr_rules').empty();
  if (!s.rules.length) {
    $list.append('<div class="pfr-empty">No rules yet. Click "Add rule".</div>');
    return;
  }

  s.rules.forEach((rule, i) => {
    const $r = $(RULE_HTML).toggleClass('pfr-disabled', !rule.enabled);

    $r.find('.pfr-enabled').prop('checked', rule.enabled).on('change', e => {
      rule.enabled = e.target.checked;
      $r.toggleClass('pfr-disabled', !rule.enabled);
      save();
    });

    $r.find('.pfr-name').val(rule.name).on('input', e => { rule.name = e.target.value; save(); });

    const $find = $r.find('.pfr-find').val(rule.find);
    const validate = () => {
      let err = '';
      if (rule.find) { try { parseRegex(rule.find); } catch (e) { err = e.message; } }
      $find.toggleClass('pfr-invalid', !!err).attr('title', err);
    };
    $find.on('input', e => { rule.find = e.target.value; validate(); save(); });
    validate();

    $r.find('.pfr-replace').val(rule.replace).on('input', e => { rule.replace = e.target.value; save(); });

    const $fields = $r.find('.pfr-fields');
    for (const [key, label] of Object.entries(FIELDS)) {
      const $cb = $('<label class="checkbox_label"><input type="checkbox"><span></span></label>');
      $cb.find('span').text(label);
      $cb.find('input').prop('checked', !!rule.fields?.[key]).on('change', e => {
        rule.fields ??= {};
        rule.fields[key] = e.target.checked;
        save();
      });
      $fields.append($cb);
    }

    $r.find('.pfr-up').on('click', () => moveRule(i, -1));
    $r.find('.pfr-down').on('click', () => moveRule(i, 1));
    $r.find('.pfr-del').on('click', () => {
      if (!confirm(`Delete rule "${rule.name || rule.find || 'untitled'}"?`)) return;
      s.rules.splice(i, 1);
      save();
      renderRules();
    });

    $list.append($r);
  });
}

function moveRule(i, dir) {
  const rules = getSettings().rules;
  const j = i + dir;
  if (j < 0 || j >= rules.length) return;
  [rules[i], rules[j]] = [rules[j], rules[i]];
  save();
  renderRules();
}

function showPreview() {
  const ctx = SillyTavern.getContext();
  const esc = s => $('<div>').text(s).html();
  let html = '<div class="pfr-preview"><h3>Prompt Field Regex – Preview</h3>';
  let any = false;

  for (const { field, label, text, sub } of getFieldTexts()) {
    if (!text) continue;
    any = true;
    const original = sub(text).trim();
    const edited = applyRules(original, rulesFor(field));
    const changed = edited !== original;
    html += `<h4>${esc(label)} <small class="${changed ? 'pfr-changed' : ''}">(${changed ? 'changed' : 'unchanged'})</small></h4>`;
    if (changed) html += `<pre>${esc(edited)}</pre>`;
  }
  if (!any) html += '<p>No character or persona text found. Open a chat first.</p>';
  html += '</div>';

  if (ctx.callGenericPopup) {
    ctx.callGenericPopup(html, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
  } else {
    console.log(html);
    toastr.info('Preview logged to console (popup API not found).');
  }
}

function exportRules() {
  const blob = new Blob([JSON.stringify(getSettings().rules, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prompt-field-regex.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importRules(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.rules;
    if (!Array.isArray(list)) throw new Error('No rules found in file.');
    const s = getSettings();
    for (const r of list) s.rules.push({ ...newRule(), ...r, id: newId() });
    save();
    renderRules();
    toastr.success(`Imported ${list.length} rule(s).`);
  } catch (e) {
    toastr.error(e.message, 'Import failed');
  }
}

// ================= Init =================
jQuery(() => {
  $('#extensions_settings2').append(PANEL_HTML);
  const s = getSettings();

  $('#pfr_enabled').prop('checked', s.enabled).on('change', e => { s.enabled = e.target.checked; save(); });
  $('#pfr_debug').prop('checked', s.debug).on('change', e => { s.debug = e.target.checked; save(); });
  $('#pfr_add').on('click', () => { s.rules.push(newRule()); save(); renderRules(); });
  $('#pfr_preview').on('click', showPreview);
  $('#pfr_export').on('click', exportRules);
  $('#pfr_import').on('click', () => $('#pfr_import_file').trigger('click'));
  $('#pfr_import_file').on('change', e => {
    const f = e.target.files[0];
    if (f) importRules(f);
    e.target.value = '';
  });

  renderRules();
  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
});
