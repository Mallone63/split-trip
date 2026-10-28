/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class TripNotFoundError extends Error {
  constructor() {
    super('Поездка не найдена. Проверьте ссылку приглашения.');
    this.name = 'TripNotFoundError';
  }
}
