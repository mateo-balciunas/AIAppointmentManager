import type { LlmProvider } from './port.js';
import { FakeProvider } from './providers/fake.js';
import { OpenAIProvider } from './providers/openai.js';

/**
 * Global registry for LLM providers
 * Allows registering and retrieving providers by name
 */
class ProviderRegistry {
  private providers = new Map<string, LlmProvider>();

  /**
   * Registers a new provider in the registry
   */
  register(provider: LlmProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Gets a provider by name
   * Throws error if does not exist
   */
  get(name: string): LlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const available = Array.from(this.providers.keys()).join(', ');
      throw new Error(`Provider "${name}" not found. Available providers: ${available}`);
    }
    return provider;
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

// Register available providers
registry.register(new FakeProvider());
registry.register(new OpenAIProvider());

// TODO: Register other providers when implemented
// registry.register(new AnthropicProvider());
// registry.register(new GeminiProvider());

/**
 * Gets the configured provider for the LLM_PROVIDER env var
 * Uses 'fake' by default
 */
export function getConfiguredProvider(): LlmProvider {
  const providerName = process.env.LLM_PROVIDER || 'fake';
  return registry.get(providerName);
}
