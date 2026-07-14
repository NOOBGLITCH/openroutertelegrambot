const TELEGRAM_API = "https://api.telegram.org/bot";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "openrouter/free";

const MAX_HISTORY = 20;
const userModels = {};
const userPrompts = {};
const userHistory = {};

async function tg(method, payload) {
  const res = await fetch(`${TELEGRAM_API}${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function trySend(chatId, text) {
  const r = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
  });
  if (r.ok) return r;
  const r2 = await tg("sendMessage", {
    chat_id: chatId,
    text: mdToHtml(text),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  if (r2.ok) return r2;
  return tg("sendMessage", {
    chat_id: chatId,
    text: stripMarkdown(text),
  });
}

async function tryEdit(chatId, msgId, text) {
  const r = await tg("editMessageText", {
    chat_id: chatId,
    message_id: msgId,
    text,
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
  });
  if (r.ok) return r;
  const r2 = await tg("editMessageText", {
    chat_id: chatId,
    message_id: msgId,
    text: mdToHtml(text),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  if (r2.ok) return r2;
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: msgId,
    text: stripMarkdown(text),
  });
}

function esc(t) {
  return t.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function escHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHtml(t) {
  const blocks = [];
  let i = 0;
  const lines = t.split("\n");
  while (i < lines.length) {
    if (/^```(\w*)/.test(lines[i])) {
      const lang = lines[i].match(/^```(\w*)/)[1];
      i++;
      let code = "";
      while (i < lines.length && !lines[i].startsWith("```")) {
        code += lines[i] + "\n";
        i++;
      }
      i++;
      const tag = lang ? `<pre><code class="language-${lang}">${escHtml(code.trim())}</code></pre>` : `<pre>${escHtml(code.trim())}</pre>`;
      blocks.push(tag);
    } else {
      blocks.push(lines[i]);
      i++;
    }
  }

  let h = blocks.join("\n");
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  h = h.replace(/~~(.+?)~~/g, "<s>$1</s>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
  h = h.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return h;
}

function stripMarkdown(t) {
  return t
    .replace(/```[\w]*\n[\s\S]*?```/g, (m) => m.replace(/```\w*\n/, "").replace(/```/, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#+\s+/gm, "")
    .replace(/^>\s+/gm, "");
}

function buildMsgs(chatId, userMsg) {
  const m = [];
  const s = userPrompts[chatId];
  if (s) m.push({ role: "system", content: s });
  const h = userHistory[chatId] || [];
  m.push(...h);
  m.push({ role: "user", content: userMsg });
  return m;
}

function clearChat(chatId) {
  delete userModels[chatId];
  delete userPrompts[chatId];
  delete userHistory[chatId];
}

async function doAI(chatId, modelId, userMsg) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  const res = await fetch(OPENROUTER_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: modelId, messages: buildMsgs(chatId, userMsg) }),
  });

  const data = await res.json();
  if (!res.ok) {
    return trySend(chatId, `Error: ${escHtml((data.error?.message || "").slice(0, 400))}`);
  }

  const content = data.choices?.[0]?.message?.content || "";
  if (!content) return trySend(chatId, "Empty response.");

  const usedModel = data.model || modelId;

  userHistory[chatId] = userHistory[chatId] || [];
  userHistory[chatId].push({ role: "user", content: userMsg });
  userHistory[chatId].push({ role: "assistant", content });
  if (userHistory[chatId].length > MAX_HISTORY * 2) {
    userHistory[chatId] = userHistory[chatId].slice(-MAX_HISTORY * 2);
  }

  let reply = content.trim();
  if (usedModel !== modelId) reply += `\n\n— ${usedModel}`;

  if (reply.length <= 4000) return trySend(chatId, reply);

  const parts = reply.split("\n\n");
  let chunk = "";
  for (const p of parts) {
    const c = chunk ? `${chunk}\n\n${p}` : p;
    if (c.length > 4000) {
      if (chunk) await trySend(chatId, chunk);
      chunk = p.length > 4000 ? p.slice(0, 4000) : p;
    } else {
      chunk = c;
    }
  }
  if (chunk) await trySend(chatId, chunk);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).json({ ok: true });

    const msg = req.body?.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const cid = msg.chat.id;
    const t = msg.text.trim();
    const l = t.toLowerCase();

    if (l === "/start") {
      clearChat(cid);
      await trySend(cid, `Hi, I am your AI assistant! 🤖\n\nDefault model: \`${esc(DEFAULT_MODEL)}\`\n\nSend any message and I'll reply with context.\n*Commands:*\n/help — show all commands`);
    } else if (l.startsWith("/help")) {
      await trySend(cid, `*Available commands*\n\n/start — reset everything\n/help — show this\n/model — show current model\n/model <id> — set model (e.g. \`/model openrouter/free\`)\n/prompt — show system prompt\n/prompt <text> — set custom prompt\n/prompt reset — remove prompt\n/new — clear history\n/exit — reset all`);
    } else if (l.startsWith("/model")) {
      const a = t.slice(6).trim();
      if (a) { userModels[cid] = a; await trySend(cid, `Model set to: \`${esc(a)}\``); }
      else { await trySend(cid, `Current: \`${esc(userModels[cid] || DEFAULT_MODEL)}\`\n\nChange: \`/model <id>\``); }
    } else if (l.startsWith("/prompt")) {
      const a = t.slice(7).trim();
      if (!a) {
        const c = userPrompts[cid];
        await trySend(cid, c ? `*System prompt:*\n${esc(c)}\n\nUse \`/prompt reset\` to remove.` : `No custom prompt.\nSet: \`/prompt You are helpful.\``);
      } else if (a === "reset") { delete userPrompts[cid]; await trySend(cid, "Prompt removed."); }
      else { userPrompts[cid] = a; await trySend(cid, "Prompt updated."); }
    } else if (l === "/new") { delete userHistory[cid]; await trySend(cid, "History cleared."); }
    else if (l === "/exit") { clearChat(cid); await trySend(cid, "Reset. Send anything to start."); }
    else { await doAI(cid, userModels[cid] || DEFAULT_MODEL, t); }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("FATAL:", e);
    try { await tg("sendMessage", { chat_id: req.body?.message?.chat?.id || 0, text: `Internal error` }); } catch {}
    res.status(200).json({ ok: true });
  }
}
