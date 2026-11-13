import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expenseInput, errorResponse, type ExpenseService } from './service';

export function createMcpServer(service: ExpenseService): McpServer {
  const server = new McpServer({ name: 'split-trip', version: '1.1.0' });
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
    description: 'Add a shared or personal expense. Read get_trip first to resolve names and wallets. kind=shared (default) requires participantIds and paid, with optional exact shares. kind=personal requires memberId and amountMinor; it automatically includes that member and everyone sharing their non-null unit, without changing wallet debts. Do not supply participantIds, paid or shares for personal expenses. Ask when currency, local date or member identity is unclear; for shared expenses also resolve payers and participants. Use a new UUID requestId for each expense and reuse it with the same arguments on retries. Amounts are integer minor units (100 RUB = 10000; 100 JPY = 100).',
    inputSchema: expenseInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, input => result(() => service.addExpense(input)));
  return server;
}
