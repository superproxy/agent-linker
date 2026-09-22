import type { AuthErrorHandler } from '../lib/hooks';
import { NodeKeyPanel } from '../components/node-key-panel';

export function NodeKeyPage(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  return <NodeKeyPanel base={props.base} token={props.token} onAuthError={props.onAuthError} />;
}
