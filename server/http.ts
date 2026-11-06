import type { IncomingMessage } from 'node:http';
import { ApiError } from './auth';
const MAX_BODY = 32768;
export async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'json_required', 'Send application/json.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'body_too_large', 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { throw new ApiError(400, 'invalid_json', 'Expected a JSON object.'); }
}
