# WhatsApp Shopping Aggregator

An AI shopping assistant on WhatsApp that searches, compares, and helps buy products across **6 Indian e-commerce platforms**: Amazon, Flipkart, Myntra, Meesho, Nykaa, and Ajio.

Built on the **Model Context Protocol (MCP)** — the product tools (search, compare, details, buy link) run as an MCP server, and a Groq-powered LLM agent (free tier) calls them to answer WhatsApp messages.

## Features

- 🔍 **Cross-platform search** with budget filters — results ranked by a value score (rating² / price, boosted by discount off MRP)
- 💡 **Cheapest & best-value platform** flagged automatically on every search
- 📊 **Side-by-side comparison** with a savings callout
- 💳 **In-chat buy flow** — tap *Buy Now*, share address & phone, get a direct checkout link
- ❤️ **Wishlist** — save products, recall with `wishlist` (or `meri list`)
- 🇮🇳 **Hindi/Hinglish support** — auto-detected from Devanagari input
- 🎛️ **Interactive WhatsApp UI** — buttons and tappable lists, not just text

## Architecture

```
WhatsApp Cloud API ──▶ Express webhook ──▶ Groq agent (llama-3.3-70b, tool calling)
                                                │  MCP client (stdio)
                                                ▼
                                        MCP server (4 tools)
                                                │
                       ┌─────────┬─────────┬────┴────┬─────────┬─────────┐
                     Amazon   Flipkart   Myntra   Meesho    Nykaa     Ajio
                    (scrape)  (scrape)   (API)    (API)     (API)     (API)
```

**Data sources (in priority order):**
1. **SerpApi Google Shopping** (recommended) — set `SERPAPI_KEY` in `.env` for real, authenticated product data, prices, and buy links across all major Indian stores in one API call. Free tier: 100 searches/month at https://serpapi.com.
2. **Per-platform scrapers** — best-effort, unauthenticated; the sites' internal APIs change and block frequently.
3. **Demo catalog** — bundled mock data, used ONLY when `USE_MOCK_DATA=true` (offline demos). In live mode a failed search honestly returns "no results" — demo products are never mixed into real results.

## Setup

1. **Install & configure**
   ```bash
   npm install
   cp .env.example .env   # fill in your keys (see comments in the file)
   ```
   You need: a Meta WhatsApp Cloud API app (access token, phone number ID, verify token, app secret) and a free [Groq API key](https://console.groq.com).

2. **Build & run**
   ```bash
   npm run build
   npm start              # serves /webhook and /health on PORT (default 3000)
   ```

3. **Point Meta at your webhook** — set the callback URL to `https://<your-host>/webhook` with your `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

### Docker

```bash
docker build -t shopping-aggregator .
docker run --env-file .env -p 3000:3000 shopping-aggregator
```

### Tests

```bash
npm test   # builds, then runs a mock-mode smoke test across all 6 platforms
```

## Production notes

- `NODE_ENV=production` **fails fast** if any required env var (including `WHATSAPP_APP_SECRET`) is missing.
- Webhook payloads are verified against Meta's `X-Hub-Signature-256` HMAC.
- Duplicate webhook deliveries are dropped; messages are processed serially per user; per-user rate limiting (10 msgs/min) protects the Groq quota.
- Sessions are in-memory with a 30-minute TTL — for multi-instance deployments put a sticky session in front, or swap `sessionManager.ts` for Redis.
- The scraper endpoints for Myntra/Meesho/Nykaa/Ajio are internal APIs and may change without notice; mock fallback keeps the bot functional if they do.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with reload (build once first so the MCP server exists in `dist/`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the production server |
| `npm run mcp:server` | Run the MCP tool server standalone (stdio) |
| `npm test` | Build + mock-mode smoke test |
