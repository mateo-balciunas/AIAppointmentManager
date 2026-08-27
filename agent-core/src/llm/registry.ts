import type { LlmProvider } from "./port.js";
import { FakeProvider } from "./providers/fake.js";

/**
 * Global registry for LLM providers
 * Allows to register and get providers by name
 */

class ProviderRegistry {
    private providers = new Map<string, LlmProvider>();

    /**
     * Registers a new provider in the registry
     */
    register(provider: LlmProvider): void {
        if (this.providers.has(provider.name)) {
            throw new Error(`Provider "${provider.name}" already registered`);
        }
        this.providers.set(provider.name, provider);
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
    list(): strong[] {
        return Array.from(this.providers.keys());
    }
}

// Singleton instance of the registry
export const registry = new ProviderRegistry();

//Register available providers
registry.register(new FakeProvider());

// TODO: Register real providers here
// registry.register(new OpenAIProvider());
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