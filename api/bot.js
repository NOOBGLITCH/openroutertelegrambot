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

async function sendRich(chatId, markdown) {
  const r = await tg("sendRichMessage", {
    chat_id: chatId, rich_message: { markdown }, link_preview_options: { is_disabled: true },
  });
  if (r.ok) return r;
  const plain = markdown.replace(/```[\w]*\n[\s\S]*?```/g, "$&".replace(/```\w*\n/,"").replace(/```/,"")).replace(/[*_`#>[\]|~-]/g, "").replace(/\n{3,}/g, "\n").trim();
  return tg("sendMessage", { chat_id: chatId, text: plain });
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
    return sendRich(chatId, `Error: ${(data.error?.message || "").slice(0, 400)}`);

  const content = data.choices?.[0]?.message?.content || "";
  if (!content) return sendRich(chatId, "Empty response.");

  const usedModel = data.model || modelId;

  userHistory[chatId] = userHistory[chatId] || [];
  userHistory[chatId].push({ role: "user", content: userMsg });
  userHistory[chatId].push({ role: "assistant", content });
  if (userHistory[chatId].length > MAX_HISTORY * 2)
    userHistory[chatId] = userHistory[chatId].slice(-MAX_HISTORY * 2);

  let reply = content.trim();
  if (usedModel !== modelId) reply += `\n\n— ${usedModel}`;

  if (reply.length <= 4000) return sendRich(chatId, reply);

  const parts = reply.split("\n\n");
  let chunk = "";
  for (const p of parts) {
    const c = chunk ? `${chunk}\n\n${p}` : p;
    if (c.length > 4000) {
      if (chunk) await sendRich(chatId, chunk);
      chunk = p.length > 4000 ? p.slice(0, 4000) : p;
    } else {
      chunk = c;
    }
  }
  if (chunk) await sendRich(chatId, chunk);
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
      await sendRich(cid, `Hi, I am your AI assistant! 🤖\n\nDefault model: \`${DEFAULT_MODEL}\`\n\n**Commands:**\n- \`/help\` — show all commands\n- \`/model\` — show current model\n- \`/model <id>\` — set a custom model\n- \`/prompt\` — show system prompt\n- \`/prompt <text>\` — set a custom prompt\n- \`/prompt reset\` — remove custom prompt\n- \`/new\` — clear history\n- \`/exit\` — reset everything`);
    } else if (l.startsWith("/help")) {
      await sendRich(cid, `**Available Commands**\n\n\`/start\` — reset everything\n\`/help\` — show this message\n\`/model\` — show current model\n\`/model <id>\` — set a custom model\n\`/prompt\` — show system prompt\n\`/prompt <text>\` — set a custom prompt\n\`/prompt reset\` — remove custom prompt\n\`/new\` — clear conversation history\n\`/exit\` — reset everything`);
    } else if (l.startsWith("/model")) {
      const a = t.slice(6).trim();
      if (a) { userModels[cid] = a; await sendRich(cid, `Model set to: \`${a}\``); }
      else { await sendRich(cid, `Current model: \`${userModels[cid] || DEFAULT_MODEL}\`\n\nChange: \`/model <id>\``); }
    } else if (l.startsWith("/prompt")) {
      const a = t.slice(7).trim();
      if (!a) {
        const c = userPrompts[cid];
        await sendRich(cid, c ? `**System prompt:**\n\`${c}\`\n\nUse \`/prompt reset\` to remove.` : `No custom prompt set.\nSet one: \`/prompt You are helpful.\``);
      } else if (a === "reset") { delete userPrompts[cid]; await sendRich(cid, `Prompt removed.`); }
      else { userPrompts[cid] = a; await sendRich(cid, `Prompt updated.`); }
    } else if (l === "/new") { delete userHistory[cid]; await sendRich(cid, `History cleared.`); }
    else if (l === "/exit") { clearChat(cid); await sendRich(cid, `Reset. Send anything to start.`); }
    else { await doAI(cid, userModels[cid] || DEFAULT_MODEL, t); }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    try { await tg("sendMessage", { chat_id: req.body?.message?.chat?.id || 0, text: "Error" }); } catch {}
    res.status(200).json({ ok: true });
  }
}
