import { useLocation } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '../components/ui/button';
import { useSession } from '../lib/session';
export default function Existing() {
 const location = useLocation(), {signOut} = useSession();
 const path = location.pathname.slice(1);
 return <section className="panel empty"><h2>This screen is in the existing app</h2><p>All management tools are available there while we update the workspace. Sign in again with your owner token.</p><Button asChild><a href={'/legacy#' + path} onClick={signOut}>Open {path === 'secrets' ? 'Keys / Secrets' : path === 'audit' ? 'Audit log' : path} <ArrowUpRight size={16} /></a></Button></section>;
}
