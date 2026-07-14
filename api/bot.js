const TELEGRAM_API = "https://api.telegram.org/bot";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "openrouter/free";
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

const MAX_HISTORY = 20;
const userModels = {};
const userPrompts = {};
const userHistory = {};
const reminders = {};
let reminderIdCounter = 0;

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
  const plain = markdown.replace(/```[\w]*\n[\s\S]*?```/g, m => m.replace(/```\w*\n/,"").replace(/```/,"")).replace(/[*_`#>[\]|~-]/g, "").replace(/\n{3,}/g, "\n").trim();
  return tg("sendMessage", { chat_id: chatId, text: plain });
}

function istNow() {
  return new Date(Date.now() + IST_OFFSET);
}

function parseTime(text) {
  const now = istNow();
  const l = text.toLowerCase();

  const timeMatch = l.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  let targetHour = timeMatch ? parseInt(timeMatch[1]) : null;
  let targetMin = timeMatch ? parseInt(timeMatch[2]) : 0;
  const isPM = timeMatch?.[3] === "pm";
  if (isPM && targetHour < 12) targetHour += 12;
  if (!isPM && targetHour === 12) targetHour = 0;

  if (targetHour !== null) {
    const target = new Date(now);
    target.setHours(targetHour, targetMin, 0, 0);

    if (l.includes("tomorrow")) target.setDate(target.getDate() + 1);
    else if (l.includes("next week")) target.setDate(target.getDate() + 7);
    else {
      const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      for (let i = 0; i < dayNames.length; i++) {
        if (l.includes(dayNames[i])) {
          const diff = (i - target.getDay() + 7) % 7;
          target.setDate(target.getDate() + (diff || 7));
          break;
        }
      }
    }

    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }

  const inMatch = l.match(/in\s+(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs|day|days)\b/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2][0];
    const target = new Date(now);
    if (unit === "m") target.setMinutes(target.getMinutes() + n);
    else if (unit === "h") target.setHours(target.getHours() + n);
    else if (unit === "d") target.setDate(target.getDate() + n);
    return target;
  }

  return null;
}

async function parseReminderAI(text) {
  try {
    const res = await fetch(OPENROUTER_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [{
          role: "system",
          content: "Extract the reminder time and message from user input. Return ONLY a JSON object: {\"time\":\"ISO datetime string or natural language\",\"message\":\"what to remind\"}. Use IST timezone (UTC+5:30). Current time is " + istNow().toISOString(),
        }, { role: "user", content: text }],
      }),
    });
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw.replace(/```json\s*|```/g, "").trim());
    return parsed;
  } catch {
    return null;
  }
}

async function checkReminders() {
  const now = Date.now();
  for (const [id, rem] of Object.entries(reminders)) {
    if (rem.fired) continue;
    if (rem.time <= now) {
      rem.fired = true;
      const timeStr = new Date(rem.time + IST_OFFSET).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      await sendRich(rem.chatId, `⏰ **Reminder**\n\n${rem.message}\n\n_Set at ${timeStr}_`);
    }
  }
}

function addReminder(chatId, timeMs, message) {
  const id = ++reminderIdCounter;
  reminders[id] = { id, chatId, time: timeMs, message, fired: false, createdAt: Date.now() };
  return id;
}

function listReminders(chatId) {
  return Object.values(reminders).filter(r => r.chatId === chatId && !r.fired);
}

function formatTime(ts) {
  const d = new Date(ts + IST_OFFSET);
  const h = d.getHours(), m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return `${d.toLocaleDateString("en-IN")} ${hour12}:${m} ${ampm} IST`;
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

async function handleRemind(cid, text) {
  const args = text.slice(8).trim();
  if (!args) {
    await sendRich(cid, `Usage: \`/remind in 2 hours call mom\`\nor: \`/remind tomorrow 9am buy groceries\``);
    return;
  }

  await tg("sendChatAction", { chat_id: cid, action: "typing" });

  const t = parseTime(args);
  if (t) {
    const msg = args.replace(/in\s+\d+\s*(min|mins|minute|minutes|hour|hours|hr|hrs|day|days)\s*/i, "").trim()
      .replace(/^(tomorrow|today|next\s+\w+)\s*/i, "").replace(/\d{1,2}:\d{2}\s*(am|pm)?\s*/i, "").trim();
    const finalMsg = msg || args;
    const id = addReminder(cid, t.getTime(), finalMsg);
    await sendRich(cid, `✅ Reminder set for ${formatTime(t.getTime())}\n\n_${finalMsg}_\n\nID: \`${id}\` — use \`/delreminder ${id}\` to cancel`);
    return;
  }

  const ai = await parseReminderAI(args);
  if (ai?.time && ai?.message) {
    const parsedTime = new Date(ai.time).getTime();
    if (!isNaN(parsedTime)) {
      const id = addReminder(cid, parsedTime, ai.message);
      await sendRich(cid, `✅ Reminder set for ${formatTime(parsedTime)}\n\n_${ai.message}_\n\nID: \`${id}\` — use \`/delreminder ${id}\` to cancel`);
      return;
    }
  }

  await sendRich(cid, `Couldn't understand that time. Try:\n- \`in 2 hours\`\n- \`tomorrow 9am\`\n- \`next monday 10:30\``);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).json({ ok: true });
    const msg = req.body?.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const cid = msg.chat.id;
    const t = msg.text.trim();
    const l = t.toLowerCase();

    await checkReminders();

    if (l === "/start") {
      clearChat(cid);
      await sendRich(cid, `Hi, I am your AI assistant! 🤖\n\nDefault model: \`${DEFAULT_MODEL}\`\n\n**Commands:**\n- \`/help\` — show all\n- \`/remind\` — set a reminder\n- \`/reminders\` — list reminders\n- \`/model\` — show/set model\n- \`/prompt\` — show/set prompt\n- \`/new\` — clear history\n- \`/exit\` — reset all`);
    } else if (l.startsWith("/help")) {
      await sendRich(cid, `**Commands**\n\n\`/start\` — reset everything\n\`/help\` — show this\n\`/remind\` — set reminder\n\`/reminders\` — list reminders\n\`/delreminder <id>\` — cancel a reminder\n\`/model\` — show/set model\n\`/prompt\` — show/set prompt\n\`/new\` — clear history\n\`/exit\` — reset all`);
    } else if (l.startsWith("/remind")) {
      await handleRemind(cid, t);
    } else if (l.startsWith("/reminders")) {
      const list = listReminders(cid);
      if (!list.length) await sendRich(cid, "No active reminders.");
      else {
        const lines = list.map(r => `- \`${r.id}\`: ${formatTime(r.time)} — ${r.message}`);
        await sendRich(cid, `**Your Reminders**\n\n${lines.join("\n")}`);
      }
    } else if (l.startsWith("/delreminder") || l.startsWith("/delremind")) {
      const id = parseInt(t.split(/\s+/)[1]);
      if (reminders[id] && reminders[id].chatId === cid) {
        reminders[id].fired = true;
        await sendRich(cid, `Reminder \`${id}\` cancelled.`);
      } else {
        await sendRich(cid, `No reminder with ID \`${id}\`.`);
      }
    } else if (l.startsWith("/model")) {
      const a = t.slice(6).trim();
      if (a) { userModels[cid] = a; await sendRich(cid, `Model set to: \`${a}\``); }
      else { await sendRich(cid, `Current: \`${userModels[cid] || DEFAULT_MODEL}\`\n\nChange: \`/model <id>\``); }
    } else if (l.startsWith("/prompt")) {
      const a = t.slice(7).trim();
      if (!a) {
        const c = userPrompts[cid];
        await sendRich(cid, c ? `**Prompt:**\n\`${c}\`\n\nUse \`/prompt reset\` to remove.` : `No custom prompt.\nSet: \`/prompt You are helpful.\``);
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
