import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/adapters/anthropic/fetch';
import { fetchModels } from '../src/adapters/anthropic/models';
import { errorEnvelope, jsonResponse } from './helpers';

describe('fetchModels', () => {
  it('pagina por after_id, envia os headers e descarta Modelos aposentados', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];

    const fetchImpl: FetchLike = async (input, init) => {
      urls.push(String(input));
      headers.push(init?.headers as unknown as Record<string, string>);

      if (urls.length === 1) {
        return jsonResponse(200, {
          data: [
            {
              id: 'm1',
              display_name: 'Um',
              max_tokens: 100,
              max_input_tokens: 1_000,
              created_at: '2026-01-01T00:00:00Z',
              lifecycle: 'active',
            },
            { id: 'old', lifecycle: 'deprecated' },
          ],
          has_more: true,
          last_id: 'm1',
        });
      }

      return jsonResponse(200, {
        data: [{ id: 'm2', lifecycle: 'active' }],
        has_more: false,
        last_id: null,
      });
    };

    const models = await fetchModels('sk-test', fetchImpl, new AbortController().signal);

    expect(models.map((model) => model.id)).toEqual(['m1', 'm2']);
    expect(models[1]).toMatchObject({
      displayName: 'm2',
      maxTokens: null,
      maxInputTokens: null,
    });
    expect(urls[1]).toContain('after_id=m1');
    expect(headers[0]).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });

  it('traduz 401 em AppError', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(401, errorEnvelope('authentication_error', 'invalid key'));

    await expect(
      fetchModels('bad', fetchImpl, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });
});
