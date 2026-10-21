import { describe, expect, it } from 'vitest';
import { errorFromResponse } from '../src/adapters/anthropic/error';
import { errorEnvelope, jsonResponse } from './helpers';

const NOW = Date.parse('2026-01-01T00:00:00Z');

describe('errorFromResponse', () => {
  it('distingue chave inválida de bloqueio de CORS', async () => {
    const invalid = await errorFromResponse(
      jsonResponse(401, errorEnvelope('authentication_error', 'invalid x-api-key')),
      NOW,
    );
    expect(invalid.code).toBe('invalid_credential');

    const cors = await errorFromResponse(
      jsonResponse(
        401,
        errorEnvelope('authentication_error', "CORS requests must set 'anthropic-dangerous-direct-browser-access'"),
      ),
      NOW,
    );
    expect(cors.code).toBe('browser_access_blocked');
  });

  it('lê retry-after em segundos', async () => {
    const error = await errorFromResponse(
      jsonResponse(429, errorEnvelope('rate_limit_error', 'slow down'), { 'retry-after': '12' }),
      NOW,
    );

    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(12);
  });

  it('lê retry-after em data HTTP usando o relógio injetado', async () => {
    const error = await errorFromResponse(
      jsonResponse(429, errorEnvelope('rate_limit_error', 'slow down'), {
        'retry-after': new Date(NOW + 30_000).toUTCString(),
      }),
      NOW,
    );

    expect(error.retryAfterSeconds).toBe(30);
  });

  it('classifica contexto estourado sem depender de status específico', async () => {
    const error = await errorFromResponse(
      jsonResponse(400, errorEnvelope('invalid_request_error', 'prompt is too long: 210000 tokens')),
      NOW,
    );

    expect(error.code).toBe('context_overflow');
  });

  it('classifica sobrecarga e erro interno', async () => {
    const overloaded = await errorFromResponse(
      jsonResponse(529, errorEnvelope('overloaded_error', 'Overloaded')),
      NOW,
    );
    expect(overloaded.code).toBe('overloaded');

    const internal = await errorFromResponse(jsonResponse(500, errorEnvelope('api_error', 'boom')), NOW);
    expect(internal.code).toBe('api_error');
  });
});
