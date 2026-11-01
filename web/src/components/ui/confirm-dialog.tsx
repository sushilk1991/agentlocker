import * as Alert from '@radix-ui/react-alert-dialog';
import { Button } from './button';
export function ConfirmDialog({description, onConfirm, onCancel}: {description: string; onConfirm: () => void; onCancel: () => void}) {
 return <Alert.Root open onOpenChange={open => {if (!open) onCancel();}}><Alert.Portal><Alert.Overlay className="overlay" /><Alert.Content className="confirm-dialog">
  <Alert.Title>Confirm your decision</Alert.Title><Alert.Description>{description}</Alert.Description>
  <div className="actions"><Alert.Cancel asChild><Button variant="outline" onClick={onCancel}>Cancel</Button></Alert.Cancel><Alert.Action asChild><Button onClick={onConfirm}>Confirm decision</Button></Alert.Action></div>
 </Alert.Content></Alert.Portal></Alert.Root>;
}
