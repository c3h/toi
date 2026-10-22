import { describe, expect, it } from 'vitest';
import { anthropicFamily } from '../src/adapters/providers/anthropic/models';
import type { ProviderId } from '../src/domain/ids';
import {
  defaultModel,
  modelFamilies,
  pickedModels,
  togglePick,
  type Model,
  type ModelPicks,
} from '../src/domain/model';
import { makeModel } from './helpers';

const model = (id: string, createdAt: string, provider: ProviderId = 'anthropic'): Model =>
  makeModel(id, { createdAt, provider });

const sonnet55 = model('claude-sonnet-5-5', '2026-09-01');
const sonnet5 = model('claude-sonnet-5', '2026-05-01');
const sonnet35 = model('claude-3-5-sonnet-20241022', '2024-10-22');
const haiku55 = model('claude-haiku-5-5', '2026-08-01');
const opus55 = model('claude-opus-5-5', '2026-09-02');
const all = [sonnet5, opus55, sonnet35, haiku55, sonnet55];

const DEFAULT_PICKS: ModelPicks = {
  families: [
    { provider: 'anthropic', name: 'sonnet' },
    { provider: 'anthropic', name: 'haiku' },
  ],
  models: [],
};

/** Um segundo Provedor só existe no teste: a união de `ProviderId` ainda tem um membro. */
const gateway = 'gateway' as ProviderId;

const ids = (models: Model[]) => models.map((item) => item.id);

describe('anthropicFamily', () => {
  it('lê a família nos dois formatos de id', () => {
    expect(anthropicFamily(sonnet55.id)).toBe('sonnet');
    expect(anthropicFamily(sonnet35.id)).toBe('sonnet');
    expect(anthropicFamily('claude-2')).toBe('claude-2');
  });
});

describe('modelFamilies', () => {
  it('agrupa da versão mais recente para a mais antiga', () => {
    expect(modelFamilies(all).map((family) => [family.name, ids(family.models)])).toEqual([
      ['opus', ['claude-opus-5-5']],
      ['sonnet', ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022']],
      ['haiku', ['claude-haiku-5-5']],
    ]);
  });

  it('a mesma família em dois Provedores são duas', () => {
    const relayed = model('claude-haiku-5-5', '2026-08-02', gateway);
    expect(
      modelFamilies([haiku55, relayed]).map((family) => [family.provider, family.name]),
    ).toEqual([
      [gateway, 'haiku'],
      ['anthropic', 'haiku'],
    ]);
  });
});

describe('pickedModels', () => {
  it('por padrão oferece só a Sonnet e a Haiku mais recentes', () => {
    expect(ids(pickedModels(all, DEFAULT_PICKS))).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('uma família marcada acompanha a versão nova', () => {
    const sonnet6 = model('claude-sonnet-6', '2026-12-01');
    expect(ids(pickedModels([...all, sonnet6], DEFAULT_PICKS))).toEqual([
      'claude-sonnet-6',
      'claude-haiku-5-5',
    ]);
  });

  it('fica vazio quando nenhuma marcação existe para a Chave', () => {
    expect(
      pickedModels(all, {
        families: [{ provider: 'anthropic', name: 'fable' }],
        models: [{ provider: 'anthropic', id: 'sumiu' }],
      }),
    ).toEqual([]);
  });

  it('marcar uma família não marca a homônima de outro Provedor', () => {
    const relayed = model('claude-haiku-5-5', '2026-08-02', gateway);
    expect(pickedModels([haiku55, relayed], DEFAULT_PICKS)).toEqual([haiku55]);
  });
});

describe('defaultModel', () => {
  it('reconhece o último Modelo pelo Provedor, não só pelo id', () => {
    const relayed = model('claude-haiku-5-5', '2026-01-01', gateway);
    expect(defaultModel([haiku55, relayed], { provider: gateway, id: haiku55.id })).toBe(relayed);
  });
});

const familyOf = (target: Model) =>
  modelFamilies(all).find((family) => family.models.includes(target))!;

describe('togglePick', () => {
  it('a versão mais recente marca e desmarca a família', () => {
    const withOpus = togglePick(familyOf(opus55), DEFAULT_PICKS, opus55);
    expect(withOpus).toEqual({
      families: [...DEFAULT_PICKS.families, { provider: 'anthropic', name: 'opus' }],
      models: [],
    });
    expect(togglePick(familyOf(opus55), withOpus, opus55)).toEqual(DEFAULT_PICKS);
  });

  it('uma versão anterior marca só ela', () => {
    const picks = togglePick(familyOf(sonnet5), DEFAULT_PICKS, sonnet5);
    expect(picks).toEqual({
      families: DEFAULT_PICKS.families,
      models: [{ provider: 'anthropic', id: 'claude-sonnet-5' }],
    });
    expect(ids(pickedModels(all, picks))).toEqual([
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-5-5',
    ]);
    expect(togglePick(familyOf(sonnet5), picks, sonnet5)).toEqual(DEFAULT_PICKS);
  });
});
