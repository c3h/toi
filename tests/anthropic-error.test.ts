import { describe, expect, it } from 'vitest';
import { errorFromResponse } from '../src/adapters/anthropic/error';
import { errorEnvelope, jsonResponse } from './helpers';

describe('errorFromResponse', () => {
  it('distingue chave inválida de bloqueio de CORS', async () => {
    const invalid = await errorFromResponse(
      jsonResponse(401, errorEnvelope('authentication_error', 'invalid x-api-key')),
    );
    expect(invalid.code).toBe('invalid_credential');

    const cors = await errorFromResponse(
      jsonResponse(
        401,
        errorEnvelope('authentication_error', "CORS requests must set 'anthropic-dangerous-direct-browser-access'"),
      ),
    );
    expect(cors.code).toBe('browser_access_blocked');
  });

  it('lê retry-after em segundos', async () => {
    const error = await errorFromResponse(
      jsonResponse(429, errorEnvelope('rate_limit_error', 'slow down'), { 'retry-after': '12' }),
    );

    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(12);
  });

  it('classifica contexto estourado sem depender de status específico', async () => {
    const error = await errorFromResponse(
      jsonResponse(400, errorEnvelope('invalid_request_error', 'prompt is too long: 210000 tokens')),
    );

    expect(error.code).toBe('context_overflow');
  });

  it('classifica sobrecarga e erro interno', async () => {
    const overloaded = await errorFromResponse(
      jsonResponse(529, errorEnvelope('overloaded_error', 'Overloaded')),
    );
    expect(overloaded.code).toBe('overloaded');

    const internal = await errorFromResponse(jsonResponse(500, errorEnvelope('api_error', 'boom')));
    expect(internal.code).toBe('api_error');
  });
});
