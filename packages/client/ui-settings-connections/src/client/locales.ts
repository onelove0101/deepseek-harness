/** Locale keys for the Connections settings page. */

export type ConnectionsLocaleKey =
  | 'nav'
  | 'loading'
  | 'loadFailed'
  | 'connect'
  | 'disconnect'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'actionError'
  | 'popupBlocked'
  | 'oauthSetupHint'

export const en: Record<ConnectionsLocaleKey, string> = {
  nav: 'Connections',
  loading: 'Loading connectors…',
  loadFailed: 'Could not load connectors: {reason}',
  connect: 'Connect',
  disconnect: 'Disconnect',
  connecting: 'Waiting for Google authorization…',
  connected: 'Connected',
  disconnected: 'Not connected',
  failed: 'Connection failed',
  actionError: '{reason}',
  popupBlocked: 'Allow pop-ups to open the sign-in page, or copy the link from the browser.',
  oauthSetupHint:
    'Set GOOGLE_OAUTH_CLIENT_ID on the Host (and add redirect URI {redirectUri} in Google Cloud Console) before connecting.',
}

export const zh: Record<ConnectionsLocaleKey, string> = {
  nav: '连接',
  loading: '正在加载连接器…',
  loadFailed: '无法加载连接器：{reason}',
  connect: '连接',
  disconnect: '断开',
  connecting: '等待 Google 授权…',
  connected: '已连接',
  disconnected: '未连接',
  failed: '连接失败',
  actionError: '{reason}',
  popupBlocked: '请允许弹出窗口以打开登录页，或从浏览器复制链接。',
  oauthSetupHint:
    '连接前请在 Host 上设置 GOOGLE_OAUTH_CLIENT_ID，并在 Google Cloud Console 中添加重定向 URI：{redirectUri}',
}
