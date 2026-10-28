// How the agent should format its replies. Chord passes the agent's text straight to the channel, and channels differ:
// the WhatsApp simulator shows raw text (so "**bold**" arrives as asterisks), real WhatsApp has its own *bold* syntax,
// and a web chat may render Markdown or HTML. The format is set per channel in config and handed to the agent in
// tool results, so it can be changed on the server without re-uploading the skills.

export const REPLY_FORMATS = {
  plain: [
    'Plain text only: no Markdown and no HTML.',
    'No asterisks, underscores, backticks, # headings or tables.',
    'For a list, put each item on its own line starting with "1.", "2." and so on.',
    'Paste links as the bare URL.',
  ],
  whatsapp: [
    "Use WhatsApp's own formatting only: *bold* (single asterisks), _italic_, ~strikethrough~.",
    'No Markdown headings, tables, double asterisks or [text](url) links, and no HTML.',
    'For a list, put each item on its own line starting with "1.", "2." and so on.',
    'Paste links as the bare URL.',
  ],
  markdown: [
    'Markdown is rendered: use **bold**, short bullet or numbered lists and [text](url) links.',
    'No headings and no tables; keep it chat-sized.',
    'No HTML.',
  ],
  html: [
    'HTML is rendered: use only <b>, <i>, <br>, <ul>/<ol> with <li>, and <a href="...">.',
    'No other tags, no style or class attributes, no scripts and no Markdown.',
  ],
};

/** Parses "whatsapp=plain, web=markdown" into { whatsapp: 'plain', web: 'markdown' }. */
export function parseChannelFormats(raw) {
  const out = {};
  for (const pair of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [channel, format] = pair.split('=').map((s) => s?.trim().toLowerCase());
    if (!channel || !format) throw new Error(`REPLY_FORMAT_BY_CHANNEL entries look like "whatsapp=plain", got "${pair}"`);
    out[channel] = assertFormat(format, `REPLY_FORMAT_BY_CHANNEL (${channel})`);
  }
  return out;
}

export function assertFormat(format, name) {
  if (!REPLY_FORMATS[format]) throw new Error(`${name} must be one of ${Object.keys(REPLY_FORMATS).join(', ')}, got "${format}"`);
  return format;
}

/** The format for a channel, falling back to the default. Returned inside tool results as `reply_format`. */
export function replyFormat(config, channel) {
  const key = String(channel || '').trim().toLowerCase();
  const format = config.replyFormat.byChannel[key] || config.replyFormat.default;
  return { format, rules: REPLY_FORMATS[format] };
}
