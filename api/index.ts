import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server.js';

let cachedApp: Awaited<ReturnType<typeof createApp>>['app'] | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!cachedApp) {
      const created = await createApp();
      cachedApp = created.app;
    }
    return cachedApp(req as never, res as never);
  } catch (err) {
    console.error('Vercel handler boot error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Serverless initialization failed',
      })
    );
  }
}
