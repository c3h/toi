export interface Flusher<T> {
  push(value: T): void;
  flush(): Promise<void>;
}

export const createFlusher = <T>(
  save: (value: T) => Promise<void>,
  intervalMs: number,
): Flusher<T> => {
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let failure: unknown = null;

  const write = (): Promise<void> => {
    if (pending === null) return writing;

    const value = pending;
    pending = null;

    writing = writing.then(async () => {
      try {
        await save(value);
        failure = null;
      } catch (error) {
        failure = error;
      }
    });

    return writing;
  };

  const schedule = (): void => {
    if (timer !== null) return;

    timer = setTimeout(() => {
      timer = null;
      void write().finally(() => {
        if (pending !== null) schedule();
      });
    }, intervalMs);
  };

  return {
    push(value) {
      pending = value;
      schedule();
    },

    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      for (;;) {
        if (pending !== null) await write();
        await writing;
        if (pending === null) break;
      }

      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
    },
  };
};
