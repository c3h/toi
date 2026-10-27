import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/adapters/http/fetch';
import { fetchModels } from '../src/adapters/providers/anthropic/models';
import { EFFORTS, type Effort } from '../src/domain/model';
import { systemClock } from '../src/ports/clock';
import { jsonResponse } from './helpers';

/** A árvore de Esforço que a API devolve; `missing` marca níveis não suportados. */
const effortCapability = (missing: Effort[] = [], supported = true) => ({
  effort: {
    supported,
    ...Object.fromEntries(EFFORTS.map((name) => [name, { supported: !missing.includes(name) }])),
  },
});

/** Um Modelo como a API lista, com os campos que ela sempre manda. */
const apiModel = (id: string, fields: Record<string, unknown> = {}) => ({
  type: 'model',
  id,
  display_name: `Nome de ${id}`,
  created_at: '2026-01-01T00:00:00Z',
  capabilities: effortCapability(),
  ...fields,
});

const page = (data: unknown[]) => ({ data, has_more: false });

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
            apiModel('m1', {
              display_name: 'Um',
              max_tokens: 100,
              max_input_tokens: 1_000,
              lifecycle: 'active',
            }),
            apiModel('old', { lifecycle: 'deprecated' }),
          ],
          has_more: true,
          first_id: 'm1',
          last_id: 'old',
        });
      }

      return jsonResponse(200, page([apiModel('m2', { created_at: '2026-02-01T00:00:00Z' })]));
    };

    const models = await fetchModels('sk-test', fetchImpl, new AbortController().signal, systemClock);

    expect(models.map((model) => model.id)).toEqual(['m1', 'm2']);
    expect(models[0]).toMatchObject({ displayName: 'Um', maxTokens: 100, maxInputTokens: 1_000 });
    // Sem `max_tokens` e `max_input_tokens`, a API não informou o teto: o Modelo guarda `null`.
    expect(models[1]).toMatchObject({
      displayName: 'Nome de m2',
      maxTokens: null,
      maxInputTokens: null,
      createdAt: '2026-02-01T00:00:00Z',
    });
    expect(urls[1]).toContain('after_id=old');
    expect(headers[0]).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });
});
