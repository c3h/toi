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

const listing = (reply: () => Response) =>
  fetchModels('sk-test', async () => reply(), new AbortController().signal, systemClock);

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

  it('oferece só Modelos que aceitam a escala inteira de Esforço', async () => {
    const models = await listing(() =>
      jsonResponse(
        200,
        page([
          apiModel('escala-inteira'),
          apiModel('sem-xhigh', { capabilities: effortCapability(['xhigh']) }),
          apiModel('sem-esforco', { capabilities: effortCapability([], false) }),
        ]),
      ),
    );

    expect(models.map((model) => model.id)).toEqual(['escala-inteira']);
  });

  it.each([
    { caso: 'JSON ilegível', reply: () => new Response('<html>', { status: 200 }) },
    { caso: 'sem data', reply: () => jsonResponse(200, { has_more: false }) },
    { caso: 'data que não é lista', reply: () => jsonResponse(200, { data: {}, has_more: false }) },
    { caso: 'sem has_more', reply: () => jsonResponse(200, { data: [apiModel('m')] }) },
    {
      caso: 'has_more sem last_id',
      reply: () => jsonResponse(200, { data: [apiModel('m')], has_more: true, last_id: null }),
    },
    { caso: 'Modelo sem id', reply: () => jsonResponse(200, page([apiModel('m', { id: undefined })])) },
    {
      caso: 'Modelo sem display_name',
      reply: () => jsonResponse(200, page([apiModel('m', { display_name: undefined })])),
    },
    {
      caso: 'Modelo sem created_at',
      reply: () => jsonResponse(200, page([apiModel('m', { created_at: undefined })])),
    },
    {
      caso: 'Modelo sem capabilities.effort',
      reply: () => jsonResponse(200, page([apiModel('m', { capabilities: {} })])),
    },
    {
      caso: 'árvore de Esforço sem uma folha',
      reply: () =>
        jsonResponse(
          200,
          page([apiModel('m', { capabilities: { effort: { supported: true, low: { supported: true } } } })]),
        ),
    },
    {
      caso: 'max_tokens que não é um teto',
      reply: () => jsonResponse(200, page([apiModel('m', { max_tokens: '8192' })])),
    },
    {
      caso: 'Modelo aposentado incompleto',
      reply: () => jsonResponse(200, page([apiModel('m'), { id: 'old', lifecycle: 'deprecated' }])),
    },
  ])('página fora do contrato vira erro: $caso', async ({ reply }) => {
    await expect(listing(reply)).rejects.toMatchObject({
      code: 'unknown',
      message: 'A Anthropic enviou uma resposta ilegível.',
    });
  });

  it('parar no meio do corpo passa o abort intacto', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"data":['));
            controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason));
          },
        }),
        { status: 200 },
      );

    const pending = fetchModels('sk-test', fetchImpl, controller.signal, systemClock);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('traduz 401 em AppError', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(401, errorEnvelope('authentication_error', 'invalid key'));

    await expect(
      fetchModels('bad', fetchImpl, new AbortController().signal, systemClock),
    ).rejects.toMatchObject({ code: 'invalid_credential' });
  });
});
