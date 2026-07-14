export default function handler(req, res) {
  res.json({ status: "alive", bot_token: !!process.env.BOT_TOKEN, api_key: !!process.env.OPENROUTER_API_KEY });
}
