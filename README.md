# AI Chat (Simple Web Client)

A small, user-friendly web chat app with a lightweight Node.js backend and a simple frontend UI.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Add your AI key in `.env`:

```env
AI_API_KEY=your_real_api_key
```

## Run

```bash
npm run dev
```

Then open [http://localhost:3005](http://localhost:3005).

## Environment Variables

- `PORT`: Server port (default `3005`)
- `AI_API_KEY`: Your AI provider key
- `AI_MODEL`: Model name (default `openai/gpt-4o-mini`)
- `AI_API_URL`: Chat completions endpoint (default `https://api.vsellm.ru/v1/chat/completions`)
