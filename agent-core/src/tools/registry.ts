import type { Tool, ToolSpec } from "./port.js";
import { CheckAvailabilityTool } from "./check-availability.js";
import { BookAppointmentTool } from "./book-appointment.js";

/**
 * Registry of all available tools
 * Allows registering and retrieving tools by name
 */
class ToolRegistry {
    private tools = new Map<string, Tool>();

    /**
     * Register a tool in the registry
     */
    register(tool: Tool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool "${tool.name}" already registered`);
        }
        this.tools.set(tool.name, tool);
    }

    /**
     * Get a tool by name
     * Throws error if not found
     */
    get(name: string): Tool {
        const tool = this.tools.get(name);
        if (!tool) {
            const available = Array.from(this.tools.keys()).join(', ');
            throw new Error(`Tool "${name}" not found. Available tools: ${available}`);
        }
        return tool;
    }

    /**
     * Checks if a tool exists
     */
    has(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * List all registered tools names
     */
    list(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Get all tools as an array
     */
    getAll(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Convert all registered tools to ToolSpec format for the LLM
     * This is what gets sent in completion request
     */
    toToolSpecs(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
        return this.getAll().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.toJsonSchema(),
        }));
    }
}

//Singleton instance for the registry
export const toolRegistry = new ToolRegistry();

//Register all available tools
toolRegistry.register(new CheckAvailabilityTool());
toolRegistry.register(new BookAppointmentTool());

//TODO: Add more tools as needed
// toolRegistry.register(new CancelAppointmentTool());
// toolRegistry.register(new UpdateAppointmentTool());
// toolRegistry.register(new ListAppointmentsTool());