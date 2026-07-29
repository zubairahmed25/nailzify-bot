/**
 * Secrets Manager implementation of the `SecretsProvider` port.
 *
 * ============================================================================
 * THE CACHE IS THE WHOLE POINT
 * ============================================================================
 *
 * A `GetSecretValue` call costs ~30ms and $0.05 per 10,000 requests. Neither
 * number matters once. Both matter when a Lambda fetches four secrets on every
 * invocation: 120ms added to a customer's first token, forever, for values that
 * change monthly at most.
 *
 * The cache lives in MODULE scope, so it survives across warm invocations rather
 * than being rebuilt per request. That is the single highest-value Lambda
 * optimisation available and it costs one `Map`.
 *
 * ⚠️ THE CACHE HOLDS THE PROMISE, NOT THE RESOLVED VALUE. Caching the value
 * after `await` leaves a window where several concurrent callers all miss, all
 * fire their own request, and all write the same entry — the stampede the cache
 * exists to prevent, appearing only under concurrency. Caching the promise means
 * the second caller awaits the first caller's in-flight request.
 *
 * ============================================================================
 * ROTATION
 * ============================================================================
 *
 * A cached secret goes stale when the underlying secret rotates, and the symptom
 * is a Lambda that authenticates fine until it suddenly does not, with no deploy
 * to blame. `invalidate()` exists for that: on an auth failure, drop the entry
 * and retry once. Failing to re-read after rotation is a far more common
 * production incident than the latency this cache saves.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { SecretsProvider } from "@nailzify/core";

export interface SecretsProviderConfig {
  readonly region: string;
  readonly client?: SecretsManagerClient;
}

export interface CachingSecretsProvider extends SecretsProvider {
  /** Drop a cached value so the next `get` re-reads it. Use after an auth failure. */
  invalidate(name: string): void;
}

/**
 * Module scope, deliberately.
 *
 * Shared across every provider instance in the process, which is what makes it
 * survive warm invocations. Keyed by secret id, so two providers asking for the
 * same secret share one request.
 */
const cache = new Map<string, Promise<string>>();

export function createSecretsManagerProvider(
  config: SecretsProviderConfig,
): CachingSecretsProvider {
  const client = config.client ?? new SecretsManagerClient({ region: config.region });

  return {
    get(name) {
      const hit = cache.get(name);
      if (hit) return hit;

      const pending = fetchSecret(client, name).catch((error: unknown) => {
        // A failed fetch must NOT stay cached, or one transient error poisons
        // the container for its entire lifetime — every later invocation
        // replaying a failure that has long since resolved.
        cache.delete(name);
        throw error;
      });

      cache.set(name, pending);
      return pending;
    },

    invalidate(name) {
      cache.delete(name);
    },
  };
}

async function fetchSecret(client: SecretsManagerClient, name: string): Promise<string> {
  const result = await client.send(new GetSecretValueCommand({ SecretId: name }));

  if (typeof result.SecretString !== "string" || result.SecretString.length === 0) {
    // CDK creates these secrets EMPTY on purpose — a secret value must never be
    // in source control or a CloudFormation template. Someone then sets the
    // value out of band. Until they do, this is the failure, and saying so is
    // the difference between a five-minute fix and an afternoon.
    throw new Error(
      `Secret "${name}" has no value. CDK creates secrets empty by design; ` +
        `set it with: aws secretsmanager put-secret-value --secret-id ${name} --secret-string <value>`,
    );
  }

  return result.SecretString;
}

/** Test seam: clears the module-scope cache between cases. */
export function __resetSecretsCache(): void {
  cache.clear();
}
