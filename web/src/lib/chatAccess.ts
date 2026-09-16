export function canUseChatComposer(isNew: boolean, canSend: boolean): boolean {
  return isNew || canSend;
}

export function canUseChatControls(isNew: boolean, canManage: boolean): boolean {
  return isNew || canManage;
}
