import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expenseInput, errorResponse, type ExpenseService } from './service';

export function createMcpServer(service: ExpenseService): McpServer {
  const server = new McpServer({ name: 'split-trip', version: '1.0.0' });
  const result = async (call: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await call()) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorResponse(error)) }] };
    }
  };
  server.registerTool('get_trip', {
    description: 'Read the configured trip and its members. Resolve names to these IDs before adding expenses. Ask if names are ambiguous.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, () => result(service.getTrip));
  server.registerTool('list_expenses', {
    description: 'Read the 100 most recent expenses. All amounts are integer minor units: RUB/USD cents, JPY yen.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, () => result(service.listExpenses));
  server.registerTool('add_expense', {
    description: 'Add an expense. Read members first. Ask for missing currency, payer, participants or date. Use a new UUID requestId for each expense and reuse it with the same arguments on retries. Amounts are integer minor units (100 RUB = 10000; 100 JPY = 100).',
    inputSchema: expenseInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, input => result(() => service.addExpense(input)));
  return server;
}
