import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/adapters/http/fetch';
import { fetchModels } from '../src/adapters/providers/anthropic/models';
import { EFFORTS, type Effort } from '../src/domain/model';
import { systemClock } from '../src/ports/clock';
import { errorEnvelope, jsonResponse } from './helpers';

/** A árvore de Esforço que a API devolve; `missing` marca níveis não suportados. */
const effortCapability = (missing: Effort[] = [], supported = true) => ({
  effort: {
    supported,
    ...Object.fromEntries(EFFORTS.map((name) => [name, { supported: !missing.includes(name) }])),
  },
});

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
              capabilities: effortCapability(),
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
        data: [{ id: 'm2', capabilities: effortCapability(), lifecycle: 'active' }],
        has_more: false,
        last_id: null,
      });
    };

    const models = await fetchModels('sk-test', fetchImpl, new AbortController().signal, systemClock);

    expect(models.map((model) => model.id)).toEqual(['m1', 'm2']);
    expect(models[1]).toMatchObject({
      displayName: 'm2',
      maxTokens: null,
      maxInputTokens: null,
    });
    expect(urls[1]).toContain('after_id=m1');
    expect(headers[0]).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  });

  it('oferece só Modelos que aceitam a escala inteira de Esforço', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, {
        data: [
          { id: 'escala-inteira', capabilities: effortCapability() },
          { id: 'sem-xhigh', capabilities: effortCapability(['xhigh']) },
          { id: 'sem-esforco', capabilities: effortCapability([], false) },
        ],
        has_more: false,
        last_id: null,
      });

    const models = await fetchModels('sk-test', fetchImpl, new AbortController().signal, systemClock);

    expect(models.map((model) => model.id)).toEqual(['escala-inteira']);
  });

  it('traduz 401 em AppError', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(401, errorEnvelope('authentication_error', 'invalid key'));

    await expect(
      fetchModels('bad', fetchImpl, new AbortController().signal, systemClock),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });
});
