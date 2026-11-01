import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from './session';

export function useOverview() {
 const {api} = useSession();
 const cursor = useRef(0), version = useRef(''), lastInput = useRef(Date.now());
 const [idle, setIdle] = useState(false), [visible, setVisible] = useState(!document.hidden);
 const query = useQuery({
  queryKey: ['overview'],
  queryFn: async ({signal}) => {
   const data = await api.overview(cursor.current, version.current, signal);
   cursor.current = data.event_cursor; version.current = data.pending_version; return data;
  },
  enabled: visible, refetchInterval: visible ? (idle ? 15000 : 5000) : false,
  refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
 });
 const refetch = useRef(query.refetch); refetch.current = query.refetch;
 useEffect(() => {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => setIdle(true), Math.max(1, 60001 - (Date.now() - lastInput.current))); };
  const input = () => { lastInput.current = Date.now(); setIdle(false); arm(); };
  const visibility = () => { setVisible(!document.hidden); if (!document.hidden) void refetch.current(); };
  arm(); document.addEventListener('pointerdown', input, {passive: true}); document.addEventListener('keydown', input, {passive: true}); document.addEventListener('visibilitychange', visibility);
  return () => {clearTimeout(timer); document.removeEventListener('pointerdown', input); document.removeEventListener('keydown', input); document.removeEventListener('visibilitychange', visibility);};
 }, []);
 // Keep successful data visible after failures; elapsed time drives the warning.
 const [now, setNow] = useState(Date.now());
 useEffect(() => {const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, []);
 return {...query, stale: query.isError && (!query.dataUpdatedAt || now - query.dataUpdatedAt >= 30000), visible};
}
