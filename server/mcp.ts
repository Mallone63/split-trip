import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expenseInput, errorResponse, type ExpenseService } from './service';

export function createMcpServer(service: ExpenseService): McpServer {
  const server = new McpServer({ name: 'split-trip', version: '1.3.0' }, {
    instructions: 'For routine expense entry, take the shortest valid path. Reuse trip/member IDs already resolved by get_trip in this conversation for this configured trip; refresh only if missing, ambiguous, changed, or rejected. Use established user defaults: an omitted date means today in the known user timezone, and an omitted currency uses the established trip currency. Never invent an identity or shared participants. Pass the known requesting member as createdByMemberId for either expense kind; omit it if unknown and never infer the author from the payer. For personal expenses use the known requesting member as memberId; the server selects their wallet. Call add_expense directly once the fields are resolved. Do not read expense history, inspect source code, browse, or search personal context when this conversation already supplies the required data. Generate a UUID locally. A successful add_expense response is sufficient confirmation: do not reread the trip or history to verify it. Reply in one short sentence with title, amount and scope. On an uncertain write retry the same requestId and arguments; never use a fresh UUID. Ask only for genuinely unresolved details.',
  });
  const result = async (call: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await call()) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorResponse(error)) }] };
    }
  };
  server.registerTool('get_trip', {
    description: 'Resolve the configured trip, currency, members and wallets when unknown or changed. Reuse IDs already resolved in this conversation; do not call before every expense. Ask only if identity remains ambiguous.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, () => result(service.getTrip));
  server.registerTool('list_expenses', {
    description: 'Read the 100 most recent expenses when the user asks for history or an uncertain record needs investigation. Not needed before or after a successful add_expense. Amounts: RUB/USD cents, JPY yen.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, () => result(service.listExpenses));
  server.registerTool('add_expense', {
    description: 'Record an expense directly using known member IDs and established currency/date defaults; call get_trip only for unresolved or changed context. shared (default): participantIds + paid, optional shares. personal: memberId + amountMinor; the whole wallet is included automatically with no wallet debt. Use createdByMemberId for the known requesting member independently of the payer; omit if unknown. Ask only for unresolved identity, payer, participants, currency or local date. Use a fresh UUID per new expense; reuse the exact UUID and arguments on retry. Do not list history to check duplicates: requestId handles retries. Amounts: 100 RUB = 10000; 100 JPY = 100. On success, confirm briefly without a verification read.',
    inputSchema: expenseInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, input => result(() => service.addExpense(input)));
  return server;
}
