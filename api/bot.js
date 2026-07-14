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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// Send with MarkdownV2 for our own controlled messages
async function sendMd(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId, text: escMd(text),
    parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true },
  });
}

// Send AI response: try HTML first (forgiving), fallback plain
async function sendAi(chatId, text) {
  const html = mdToHtml(text);
  const r = await tg("sendMessage", {
    chat_id: chatId, text: html,
    parse_mode: "HTML", link_preview_options: { is_disabled: true },
  });
  if (r.ok) return r;
  return tg("sendMessage", {
    chat_id: chatId, text: stripMd(text),
  });
}

function escMd(t) {
  return t.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function escHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHtml(t) {
  const blocks = [];
  const lines = t.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^```(\w*)/.test(lines[i])) {
      const lang = lines[i].match(/^```(\w*)/)[1];
      let code = "";
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++)
        code += lines[i] + "\n";
      const inner = lang
        ? `<code class="language-${lang}">${escHtml(code.trim())}</code>`
        : escHtml(code.trim());
      blocks.push(`<pre>${inner}</pre>`);
    } else if (/^#{1,3}\s/.test(lines[i])) {
      blocks.push(`<b>${escHtml(lines[i].replace(/^#+\s*/, ""))}</b>`);
    } else if (/^>\s/.test(lines[i])) {
      const q = [];
      while (i < lines.length && /^>\s/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s*/, ""));
        i++;
      }
      i--;
      blocks.push(`<blockquote>${escHtml(q.join("\n"))}</blockquote>`);
    } else if (/^[-*+]\s/.test(lines[i])) {
      blocks.push(` • ${escHtml(lines[i].replace(/^[-*+]\s*/, ""))}`);
    } else {
      blocks.push(escHtml(lines[i]));
    }
  }

  let h = blocks.join("\n");
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  h = h.replace(/~~(.+?)~~/g, "<s>$1</s>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return h;
}

function stripMd(t) {
  return t
    .replace(/```[\w]*\n[\s\S]*?```/g, m => m.replace(/```\w*\n/, "").replace(/```/, "").trim())
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
  if (userPrompts[chatId]) m.push({ role: "system", content: userPrompts[chatId] });
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
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: buildMsgs(chatId, userMsg) }),
  });

  const data = await res.json();
  if (!res.ok)
    return sendMd(chatId, `Error: ${(data.error?.message || "").slice(0, 400)}`);

  const content = data.choices?.[0]?.message?.content || "";
  if (!content) return sendMd(chatId, "Empty response.");

  const usedModel = data.model || modelId;

  userHistory[chatId] = userHistory[chatId] || [];
  userHistory[chatId].push({ role: "user", content: userMsg });
  userHistory[chatId].push({ role: "assistant", content });
  if (userHistory[chatId].length > MAX_HISTORY * 2)
    userHistory[chatId] = userHistory[chatId].slice(-MAX_HISTORY * 2);

  let reply = content.trim();
  if (usedModel !== modelId) reply += `\n\n— ${usedModel}`;

  if (reply.length <= 4000) return sendAi(chatId, reply);

  const parts = reply.split("\n\n");
  let chunk = "";
  for (const p of parts) {
    const c = chunk ? `${chunk}\n\n${p}` : p;
    if (c.length > 4000) {
      if (chunk) await sendAi(chatId, chunk);
      chunk = p.length > 4000 ? p.slice(0, 4000) : p;
    } else {
      chunk = c;
    }
  }
  if (chunk) await sendAi(chatId, chunk);
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
      await sendMd(cid, `Hi, I am your AI assistant! 🤖\n\nDefault model: \`${escMd(DEFAULT_MODEL)}\`\n\n*Commands:*\n/help — show all`);
    } else if (l.startsWith("/help")) {
      await sendMd(cid, `*Commands*\n/start — reset\n/help — this\n/model — show model\n/model <id> — set model\n/prompt — show prompt\n/prompt <text> — set prompt\n/prompt reset — remove\n/new — clear history\n/exit — reset all`);
    } else if (l.startsWith("/model")) {
      const a = t.slice(6).trim();
      if (a) { userModels[cid] = a; await sendMd(cid, `Model set to: \`${escMd(a)}\``); }
      else { await sendMd(cid, `Current: \`${escMd(userModels[cid] || DEFAULT_MODEL)}\`\nChange: \`/model <id>\``); }
    } else if (l.startsWith("/prompt")) {
      const a = t.slice(7).trim();
      if (!a) {
        const c = userPrompts[cid];
        await sendMd(cid, c ? `*Prompt:*\n${escMd(c)}\n\n\`/prompt reset\` to remove` : `No custom prompt.\nSet: \`/prompt You are helpful.\``);
      } else if (a === "reset") { delete userPrompts[cid]; await sendMd(cid, "Prompt removed."); }
      else { userPrompts[cid] = a; await sendMd(cid, "Prompt updated."); }
    } else if (l === "/new") { delete userHistory[cid]; await sendMd(cid, "History cleared."); }
    else if (l === "/exit") { clearChat(cid); await sendMd(cid, "Reset. Send anything to start."); }
    else { await doAI(cid, userModels[cid] || DEFAULT_MODEL, t); }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("FATAL:", e);
    try { await tg("sendMessage", { chat_id: req.body?.message?.chat?.id || 0, text: "Internal error" }); } catch {}
    res.status(200).json({ ok: true });
  }
}
