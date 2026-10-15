const { eventSource, event_types } = SillyTavern.getContext();

// Your rules: [pattern, replacement]
const RULES = [
  [/\bsword\b/gi, 'katana'],
];

const transform = (text) =>
  RULES.reduce((t, [re, rep]) => t.replace(re, rep), text);

function getTargets() {
  const ctx = SillyTavern.getContext();
  const char = ctx.characters[ctx.characterId];
  return [
    char?.description,
    char?.personality,
    char?.scenario,
    ctx.powerUserSettings?.persona_description,
  ]
    .filter(Boolean)
    .map(t => ctx.substituteParams(t).trim())   // resolve {{char}}, {{user}}, etc.
    .filter(Boolean)
    .map(original => ({ original, edited: transform(original) }))
    .filter(x => x.original !== x.edited);
}

const patch = (text, targets) =>
  targets.reduce((t, { original, edited }) => t.split(original).join(edited), text);

// Chat Completion
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
  const targets = getTargets();
  for (const msg of data.chat) {
    if (typeof msg.content === 'string') msg.content = patch(msg.content, targets);
  }
});

// Text Completion
eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (data) => {
  data.prompt = patch(data.prompt, getTargets());
});
