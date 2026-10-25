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

  it('o tipo do envelope reforça 429 e 529 sob outro status', async () => {
    const overloaded = await anthropicErrors.fromResponse(
      jsonResponse(500, errorEnvelope('overloaded_error', 'Overloaded')),
      NOW,
    );
    const limited = await anthropicErrors.fromResponse(
      jsonResponse(503, errorEnvelope('rate_limit_error', 'slow down')),
      NOW,
    );

    expect(overloaded.code).toBe('overloaded');
    expect(limited.code).toBe('rate_limited');
  });

  it('sem envelope, o status decide e o statusText vira o detalhe', async () => {
    const html = await anthropicErrors.fromResponse(
      new Response('<html>', { status: 502, statusText: 'Bad Gateway' }),
      NOW,
    );
    const malformed = await anthropicErrors.fromResponse(
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
        status: 500,
        statusText: 'Internal Server Error',
      }),
      NOW,
    );

    expect(html).toMatchObject({ code: 'api_error', detail: 'Bad Gateway' });
    expect(malformed).toMatchObject({ code: 'api_error', detail: 'Internal Server Error' });
  });
});

describe('anthropicErrors.fromEvent', () => {
  it.each([
    ['authentication_error', 'invalid_credential'],
    ['permission_error', 'permission_denied'],
    ['not_found_error', 'model_unavailable'],
    ['rate_limit_error', 'rate_limited'],
    ['overloaded_error', 'overloaded'],
    ['api_error', 'api_error'],
    ['invalid_request_error', 'invalid_request'],
    ['tipo_que_a_api_acrescentar', 'unknown'],
  ])('%s vira %s', (type, code) => {
    expect(anthropicErrors.fromEvent({ type, message: 'detalhe' })).toMatchObject({
      code,
      detail: 'detalhe',
    });
  });
});
