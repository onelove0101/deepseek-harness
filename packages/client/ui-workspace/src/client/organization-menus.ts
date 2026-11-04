/** Context-menu actions that organize Workspaces into Groups and Sessions into Folders. */
import type { Context } from '@deepseek-ai/cordis'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { WorkspaceActionRequest } from './contract/slots.ts'

/** Collaborators the menu actions run against. */
export interface OrganizationMenuActions {
  /** Raise one dialog request; the browser renders and settles it. */
  readonly requestWorkspaceAction: (request: WorkspaceActionRequest) => void
  /** Durable Workspace operations. */
  readonly workspaces: IWorkspaces
}

/**
 * Register the Group and Folder actions on the Workspace, Group, Folder, and Session menus.
 * @param ctx - workspace plugin context owning menus, access, membership, and locale.
 * @param actions - dialog request and durable operations; each action runs against its captured target.
 */
export function registerOrganizationMenus(ctx: Context, actions: OrganizationMenuActions): void {
  const t = ctx.locale.bind('workspace')
  const snapshot = () => ctx.workspaces.list.getSnapshot()
  const allowed = (workspaceId: WorkspaceView['workspaceId'], action: string): boolean =>
    ctx.remoteAccess.source('workspace', workspaceId, action).getSnapshot()

  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspace.createFolder', target: 'workspace', order: 150,
    observe: ({ workspaceId }) => [ctx.workspaces.list, ctx.remoteAccess.source('workspace', workspaceId, 'workspace/createFolder')],
    resolve: ({ workspaceId, displayTitle }) => allowed(workspaceId, 'workspace/createFolder') ? [{
      id: 'createFolder', label: t('folder.create'),
      run: () => { actions.requestWorkspaceAction({ action: 'createFolder', workspaceId, displayTitle }) },
    }] : [],
  }), 'ui-workspace: create folder menu action')

  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspace.moveToGroup', target: 'workspace', order: 160,
    observe: ({ workspaceId }) => [ctx.workspaces.list, ctx.remoteAccess.source('workspace', workspaceId, 'workspace/moveToGroup')],
    resolve: ({ workspaceId }) => {
      if (!allowed(workspaceId, 'workspace/moveToGroup')) return []
      const { groups } = snapshot()
      const current = groups.find(group => group.workspaceIds.includes(workspaceId))
      const children: MenuAction[] = groups
        .filter(group => group.groupId !== current?.groupId)
        .map(group => ({
          id: `group:${group.groupId}`, label: group.title,
          run: async () => {
            try {
              await actions.workspaces.moveToGroup(workspaceId, group.groupId)
            } catch (reason: unknown) {
              console.error('workspace group move rejected:', reason)
            }
          },
        }))
      if (current !== undefined) {
        children.push({
          id: 'top-level', label: t('workspace.moveToTopLevel'),
          run: async () => {
            try {
              await actions.workspaces.moveToGroup(workspaceId, undefined)
            } catch (reason: unknown) {
              console.error('workspace group move rejected:', reason)
            }
          },
        })
      }
      return children.length === 0 ? [] : [{ id: 'moveToGroup', label: t('workspace.moveToGroup'), children }]
    },
  }), 'ui-workspace: move to group menu action')

  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceGroup.rename', target: 'workspaceGroup', order: 100,
    resolve: ({ groupId, displayTitle }) => [{
      id: 'rename', label: t('rename'), icon: { key: 'workspace.rename' },
      run: () => { actions.requestWorkspaceAction({ action: 'renameGroup', groupId, displayTitle }) },
    }],
  }), 'ui-workspace: rename group menu action')

  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceGroup.delete', target: 'workspaceGroup', order: 300,
    resolve: ({ groupId, displayTitle }) => [{
      id: 'delete', label: t('group.delete'), icon: { key: 'workspace.delete' }, danger: true, separatorBefore: true,
      run: () => { actions.requestWorkspaceAction({ action: 'deleteGroup', groupId, displayTitle }) },
    }],
  }), 'ui-workspace: dissolve group menu action')

  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceFolder.rename', target: 'workspaceFolder', order: 100,
    observe: ({ workspaceId }) => [ctx.remoteAccess.source('workspace', workspaceId, 'workspace/renameFolder')],
    resolve: ({ workspaceId, folderId, displayTitle }) => allowed(workspaceId, 'workspace/renameFolder') ? [{
      id: 'rename', label: t('rename'), icon: { key: 'workspace.rename' },
      run: () => { actions.requestWorkspaceAction({ action: 'renameFolder', workspaceId, folderId, displayTitle }) },
    }] : [],
  }), 'ui-workspace: rename folder menu action')

  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceFolder.delete', target: 'workspaceFolder', order: 300,
    observe: ({ workspaceId }) => [ctx.remoteAccess.source('workspace', workspaceId, 'workspace/deleteFolder')],
    resolve: ({ workspaceId, folderId, displayTitle }) => allowed(workspaceId, 'workspace/deleteFolder') ? [{
      id: 'delete', label: t('folder.delete'), icon: { key: 'workspace.delete' }, danger: true, separatorBefore: true,
      run: () => { actions.requestWorkspaceAction({ action: 'deleteFolder', workspaceId, folderId, displayTitle }) },
    }] : [],
  }), 'ui-workspace: delete folder menu action')

  ctx.effect(() => ctx.contextMenus.register({
    id: 'session.moveToFolder', target: 'session', order: 250,
    observe: ({ sessionId }) => [ctx.workspaces.list, ctx.remoteAccess.source('session', sessionId, 'workspace/moveSessionToFolder')],
    resolve: ({ sessionId }) => {
      if (!ctx.remoteAccess.source('session', sessionId, 'workspace/moveSessionToFolder').getSnapshot()) return []
      const workspace = snapshot().items.find(row => row.sessionIds.includes(sessionId))
      if (workspace === undefined || workspace.folders.length === 0) return []
      const filed = workspace.folders.find(folder => folder.sessionIds.includes(sessionId))
      const move = (folderId: WorkspaceView['folders'][number]['folderId'] | undefined) => async (): Promise<void> => {
        try {
          await actions.workspaces.moveSessionToFolder(workspace.workspaceId, sessionId, folderId)
        } catch (reason: unknown) {
          console.error('session folder move rejected:', reason)
        }
      }
      const children: MenuAction[] = workspace.folders
        .filter(folder => folder.folderId !== filed?.folderId)
        .map(folder => ({ id: `folder:${folder.folderId}`, label: folder.title, run: move(folder.folderId) }))
      if (filed !== undefined) {
        children.push({ id: 'workspace-root', label: t('session.moveToWorkspaceRoot'), run: move(undefined) })
      }
      return [{ id: 'moveToFolder', label: t('session.moveToFolder'), children }]
    },
  }), 'ui-workspace: move to folder menu action')
}
