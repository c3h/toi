export type LockMode = 'exclusive' | 'shared';

/** Resolve quando o lock de fato saiu; com Web Locks isso não é síncrono. */
export type Release = () => Promise<void>;

/**
 * Coordenação entre abas da mesma origem. Um lock vive até `release` ou até
 * a página morrer — o navegador o solta sozinho, sem heartbeat.
 */
export interface Locks {
  /**
   * `true` quando o lock vale entre abas. `false` no fallback em memória:
   * aí só a própria aba é coordenada e a liveness cai no Lease do Fluxo.
   */
  readonly crossTab: boolean;
  /** Tenta segurar `name` sem esperar; `null` quando outro dono o segura. */
  tryAcquire(name: string, mode?: LockMode): Promise<Release | null>;
}
