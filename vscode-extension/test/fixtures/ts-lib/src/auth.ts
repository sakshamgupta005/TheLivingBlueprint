export function authenticateToken(token: string): boolean {
  return typeof token === 'string' && token.length > 0;
}
