import { Suspense, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ClipboardCheck, Users, Folder, KeyRound, SlidersHorizontal, ScrollText, Settings, Menu, LogOut, RefreshCw, ArrowUpRight } from 'lucide-react';
import { Brand } from '../app';
import { useSession } from '../lib/session';
import { useOverview } from '../lib/polling';
import { ThemeToggle } from '../lib/theme';
import { visibleText } from '../lib/review';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetTrigger } from './ui/sheet';
import { Skeleton } from './ui/skeleton';
const navigation = [
 {path: 'approvals', title: 'Approvals', icon: ClipboardCheck}, {path: 'agents', title: 'Agents', icon: Users},
 {path: 'files', title: 'Files', icon: Folder}, {path: 'secrets', title: 'Keys', icon: KeyRound},
 {path: 'policy', title: 'Policy', icon: SlidersHorizontal}, {path: 'audit', title: 'Audit log', icon: ScrollText}, {path: 'settings', title: 'Settings', icon: Settings},
];
export default function Shell() {
 const {signOut} = useSession(), overview = useOverview(), location = useLocation();
 const [open, setOpen] = useState(false);
 const title = navigation.find(item => location.pathname === '/' + item.path)?.title || 'Approvals';
 const nav = <><Brand /><div className="sidebar-caption">WORKSPACE</div><nav aria-label="Workspace">{navigation.map(({path, title, icon: Icon}) => <NavLink to={'/' + path} key={path} onClick={() => setOpen(false)}><Icon size={18} /><span>{title}</span>{path === 'approvals' && <span className="nav-badge" aria-label={`${overview.data?.pending_count ?? 0} pending approvals`}>{overview.data?.pending_count ?? '–'}</span>}</NavLink>)}</nav>
  <div className="sidebar-bottom"><p className="hint">Your agents. Your decisions.</p><ThemeToggle /><Button variant="ghost" onClick={signOut}><LogOut size={17} />Sign out</Button></div></>;
 return <Sheet open={open} onOpenChange={setOpen}><div className="workspace"><a className="skip" href="#main">Skip to content</a><aside className="sidebar">{nav}</aside><SheetContent>{nav}</SheetContent>
  <div className="workspace-content"><header className="topbar"><SheetTrigger asChild><Button variant="ghost" className="mobile-menu" aria-label="Open navigation"><Menu size={20} /></Button></SheetTrigger><span>Workspace <span className="separator">/</span> <strong>{title}</strong></span><span className="private-label"><span className="status-dot" />Private locker</span></header>
   <main id="main" className="page" tabIndex={-1}><div className="page-heading"><div><p className="eyebrow">YOUR LOCKER</p><h1>{title}</h1></div><Button variant="outline" aria-label="Refresh now" disabled={overview.isFetching} onClick={() => void overview.refetch()}><RefreshCw size={15} />Refresh</Button></div>
    <div className="refresh-status"><span id="pending-count">{overview.data?.pending_count ?? '–'} pending approvals</span><span id="refresh-time">{overview.dataUpdatedAt ? 'Last refreshed ' + new Date(overview.dataUpdatedAt).toLocaleTimeString() : 'Waiting for refresh'}</span></div>
    {overview.stale && <p id="stale" role="status" className="warning">Activity is stale. Last refresh failed. Showing the last successful data.</p>}
    {overview.error && <p role="status" className="warning">{visibleText(overview.error.message)}</p>}
    {overview.data?.warnings.map(warning => <p className="warning" key={warning}>{visibleText(warning)}</p>)}
    <Suspense fallback={<Skeleton />}><Outlet context={{overview: overview.data, visible: overview.visible}} /></Suspense>
    <footer>Approvals stay in this locker. <a href="/legacy">Open existing management app <ArrowUpRight size={12} /></a></footer>
   </main>
  </div>
 </div></Sheet>;
}
