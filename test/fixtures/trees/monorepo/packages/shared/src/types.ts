export interface UserProfile {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'guest';
}
