const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Divide Markdown em blocos de nível superior para que só o último seja
 * reprocessado durante o Fluxo. Corta em linha em branco fora de bloco de
 * código cercado, e só quando a linha seguinte não é recuada: recuo depois de
 * linha em branco continua o item de lista anterior.
 */
export const splitBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let blank = false;

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1];

    if (fence !== null) {
      current.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }

    if (line.trim() === '') {
      blank = true;
      current.push(line);
      continue;
    }

    if (blank && !/^[ \t]/.test(line) && current.some((item) => item.trim() !== '')) {
      blocks.push(current.join('\n').trim());
      current = [];
    }

    blank = false;
    current.push(line);
    if (marker) fence = marker;
  }

  const rest = current.join('\n').trim();
  if (rest) blocks.push(rest);
  return blocks;
};
