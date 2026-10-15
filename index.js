const { eventSource, event_types } = SillyTavern.getContext();

// ===== Your rules, per field: [pattern, replacement] =====
const RULES = {
  description: [
    [/\bsword\b/gi, 'katana'],
  ],
  personality: [],
  scenario: [],
  persona: [],
};
const DEBUG = true;
// ==========================================================

const applyRules = (text, rules) =>
  rules.reduce((t, [re, rep]) => t.replace(re, rep), text);

// Active card(s): single chat or all group members
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

function getTargets() {
  const ctx = SillyTavern.getContext();
  const raw = [];

  for (const card of getCards(ctx)) {
    // 3rd arg = character name, so {{char}} resolves to this card
    const sub = t => ctx.substituteParams(t, undefined, card.name);
    raw.push(['description', card.description, sub]);
    raw.push(['personality', card.personality, sub]);
    raw.push(['scenario', card.scenario, sub]);
  }
  raw.push(['persona', ctx.powerUserSettings?.persona_description, t => ctx.substituteParams(t)]);

  const targets = [];
  for (const [field, text, sub] of raw) {
    if (!text || !RULES[field]?.length) continue;
    const original = sub(text).trim();
    if (!original) continue;
    const edited = applyRules(original, RULES[field]);
    if (edited !== original) targets.push({ field, original, edited });
  }
  return targets;
}

function patch(text, targets, stats) {
  for (const { field, original, edited } of targets) {
    if (text.includes(original)) {
      text = text.split(original).join(edited);
      stats.add(field);
    }
  }
  return text;
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
  const targets = getTargets();
  if (!targets.length) return;
  const stats = new Set();

  for (const msg of data.chat) {
    if (typeof msg.content === 'string') {
      msg.content = patch(msg.content, targets, stats);
    } else if (Array.isArray(msg.content)) {        // multimodal (images attached)
      for (const part of msg.content) {
        if (part.type === 'text') part.text = patch(part.text, targets, stats);
      }
    }
  }

  if (DEBUG && !data.dryRun) {
    const missed = targets.filter(t => !stats.has(t.field)).map(t => t.field);
    console.log('[Prompt Field Regex] patched:', [...stats], missed.length ? 'NOT found: ' + missed : '');
  }
});
