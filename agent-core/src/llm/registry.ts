import type { LlmProvider, ProviderId } from './port.js';
import { FakeProvider } from './providers/fake.js';
import { OpenAIProvider } from './providers/openai.js';

/**
 * Global registry for LLM providers
 * Allows registering and retrieving providers by name
 */
class ProviderRegistry {
  private providers = new Map<ProviderId, () => LlmProvider>();
  private instances = new Map<ProviderId, LlmProvider>();

  /**
   * Registers a new provider factory in the registry
   */
  register(id: ProviderId, factory: () => LlmProvider): void {
    if (this.providers.has(id)) {
      throw new Error(`Provider "${id}" already registered`);
    }
    this.providers.set(id, factory);
  }

  /**
   * Gets a provider by name (lazy instantiation)
   * Throws error if does not exist
   */
  get(name: string): LlmProvider {
    // Check if already instantiated
    if (this.instances.has(name as ProviderId)) {
      return this.instances.get(name as ProviderId)!;
    }

    // Get factory and instantiate
    const factory = this.providers.get(name as ProviderId);
    if (!factory) {
      const available = Array.from(this.providers.keys()).join(', ');
      throw new Error(`Provider "${name}" not found. Available providers: ${available}`);
    }

    const instance = factory();
    this.instances.set(name as ProviderId, instance);
    return instance;
  }

  /**
   * List of all registered providers
   */
  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

// Singleton instance of the registry
export const registry = new ProviderRegistry();

// Register available provider factories (lazy instantiation)
registry.register('fake', () => new FakeProvider());
registry.register('openai', () => new OpenAIProvider());

// TODO: Register other providers when implemented
// registry.register('anthropic', () => new AnthropicProvider());
// registry.register('gemini', () => new GeminiProvider());

/**
 * Gets the configured provider for the LLM_PROVIDER env var
 * Uses 'fake' by default
 */
export function getConfiguredProvider(): LlmProvider {
  const providerName = process.env.LLM_PROVIDER || 'fake';
  return registry.get(providerName);
}
