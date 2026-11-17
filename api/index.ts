import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server';

let cachedApp: Awaited<ReturnType<typeof createApp>>['app'] | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cachedApp) {
    const created = await createApp();
    cachedApp = created.app;
  }
  return cachedApp(req as never, res as never);
}
