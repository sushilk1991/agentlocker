import { createContext, useContext } from 'react';
import type { OwnerApi } from './api';
export const SessionContext = createContext<{api: OwnerApi; signOut: () => void} | null>(null);
export function useSession() {
 const value = useContext(SessionContext); if (!value) throw new Error('Sign in required'); return value;
}
