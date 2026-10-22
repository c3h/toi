import { describe, expect, it } from 'vitest';
import { anthropicErrors } from '../src/adapters/providers/anthropic/info';
import { errorEnvelope, jsonResponse } from './helpers';

const NOW = Date.parse('2026-01-01T00:00:00Z');
describe('anthropicErrors.fromResponse', () => {
  it('distingue chave inválida de bloqueio de CORS', async () => {
    const invalid = await anthropicErrors.fromResponse(
      jsonResponse(401, errorEnvelope('authentication_error', 'invalid x-api-key')),
      NOW,
    );
    expect(invalid.code).toBe('invalid_credential');

    const cors = await anthropicErrors.fromResponse(
      jsonResponse(
        401,
        errorEnvelope('authentication_error', "CORS requests must set 'anthropic-dangerous-direct-browser-access'"),
      ),
      NOW,
    );
    expect(cors.code).toBe('browser_access_blocked');
  });

  it('lê retry-after em segundos', async () => {
    const error = await anthropicErrors.fromResponse(
      jsonResponse(429, errorEnvelope('rate_limit_error', 'slow down'), { 'retry-after': '12' }),
      NOW,
    );

    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(12);
  });

  it('classifica contexto estourado sem depender de status específico', async () => {
    const error = await anthropicErrors.fromResponse(
      jsonResponse(400, errorEnvelope('invalid_request_error', 'prompt is too long: 210000 tokens')),
      NOW,
    );

    expect(error.code).toBe('context_overflow');
  });

  it('separa o anexo recusado dos outros 400', async () => {
    const classify = async (detail: string) =>
      (
        await anthropicErrors.fromResponse(
          jsonResponse(400, errorEnvelope('invalid_request_error', detail)),
          NOW,
        )
      ).code;

    expect(
      await classify('messages.0.content.0.document: A maximum of 100 PDF pages may be provided.'),
    ).toBe('attachment_rejected');
    expect(
      await classify('messages.0.content.1.image.source.base64: image exceeds 5 MB maximum'),
    ).toBe('attachment_rejected');
    expect(await classify('messages: roles must alternate between "user" and "assistant"')).toBe(
      'invalid_request',
    );
  });
});
