/**
 * Conta as páginas de um PDF sem parser: lê o `/Count` da árvore de páginas,
 * também dentro de object streams comprimidos, onde PDFs modernos guardam os
 * dicionários. É heurística: `null` quando nada se acha (PDF cifrado ou fora do
 * padrão), e a API recusa o que passar com `attachment_rejected`.
 */

// Um caractere por byte: posições no texto são offsets nos bytes.
const latin1 = new TextDecoder('latin1');

const inflate = async (data: Uint8Array<ArrayBuffer>): Promise<string> => {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return latin1.decode(await new Response(stream).arrayBuffer());
};

/** O dicionário `<< … >>` que contém a posição `index`, ou `null`. */
const enclosingDict = (text: string, index: number): string | null => {
  let depth = 0;
  let start = -1;
  for (let at = index - 1; at >= 1; at -= 1) {
    if (text.startsWith('>>', at - 1)) {
      depth += 1;
      at -= 1;
    } else if (text.startsWith('<<', at - 1)) {
      if (depth === 0) {
        start = at - 1;
        break;
      }
      depth -= 1;
      at -= 1;
    }
  }
  if (start < 0) return null;

  depth = 0;
  for (let at = start; at < text.length - 1; at += 1) {
    if (text.startsWith('<<', at)) {
      depth += 1;
      at += 1;
    } else if (text.startsWith('>>', at)) {
      depth -= 1;
      at += 1;
      if (depth === 0) return text.slice(start, at + 1);
    }
  }
  return null;
};

/** Só o primeiro nível do dicionário: `/Count` de um dicionário aninhado não vale. */
const topLevel = (dict: string): string => {
  let depth = 0;
  let out = '';
  for (let at = 0; at < dict.length; at += 1) {
    if (dict.startsWith('<<', at)) {
      depth += 1;
      at += 1;
    } else if (dict.startsWith('>>', at)) {
      depth -= 1;
      at += 1;
    } else if (depth === 1) {
      out += dict[at];
    }
  }
  return out;
};

/** O maior `/Count` entre os nós `/Pages`: a raiz soma todas as folhas. */
const pageTreeCount = (text: string): number | null => {
  let best: number | null = null;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b/g)) {
    const dict = enclosingDict(text, match.index);
    const count = dict === null ? null : /\/Count\s+(\d+)/.exec(topLevel(dict));
    if (count) best = Math.max(best ?? 0, Number(count[1]));
  }
  return best;
};

/** Onde começam os dados do stream: depois de `stream` e do fim de linha. */
const dataStart = (text: string, keyword: number): number => {
  let at = keyword + 'stream'.length;
  if (text[at] === '\r') at += 1;
  if (text[at] === '\n') at += 1;
  return at;
};

/**
 * Os object streams descomprimidos. Sem `/Length` direto, o fim é o
 * `endstream`, menos o fim de linha que o precede — a menos que esse byte
 * seja do próprio dado comprimido, e então vale o corte sem tirar nada.
 */
const objectStreams = async (text: string, bytes: Uint8Array<ArrayBuffer>): Promise<string[]> => {
  const found: string[] = [];

  for (const match of text.matchAll(/\/Type\s*\/ObjStm\b/g)) {
    const dict = enclosingDict(text, match.index);
    const keyword = text.indexOf('stream', match.index);
    if (dict === null || keyword < 0) continue;

    const start = dataStart(text, keyword);
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(topLevel(dict));
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;

    const eol = text.slice(end - 2, end) === '\r\n' ? 2 : /[\r\n]/.test(text[end - 1]!) ? 1 : 0;
    const candidates = length ? [start + Number(length[1])] : [end - eol, end];

    for (const stop of candidates) {
      try {
        found.push(await inflate(bytes.subarray(start, stop)));
        break;
      } catch {
        // Filtro que não é Flate, dado cifrado ou corte errado: tenta o próximo corte.
      }
    }
  }

  return found;
};

export const countPdfPages = async (bytes: Uint8Array<ArrayBuffer>): Promise<number | null> => {
  const text = latin1.decode(bytes);
  const texts = [text, ...(await objectStreams(text, bytes))];

  const counts = texts.map(pageTreeCount).filter((count): count is number => count !== null);
  if (counts.length > 0) return Math.max(...counts);

  // Sem árvore legível, cada folha `/Type /Page` é uma página.
  const leaves = texts.reduce(
    (sum, item) => sum + [...item.matchAll(/\/Type\s*\/Page\b/g)].length,
    0,
  );
  return leaves > 0 ? leaves : null;
};
