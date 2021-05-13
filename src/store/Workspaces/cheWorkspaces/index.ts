/*
 * Copyright (c) 2018-2020 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { Action, Reducer } from 'redux';
import * as api from '@eclipse-che/api';
import { ThunkDispatch } from 'redux-thunk';
import { AppThunk } from '../..';
import { container } from '../../../inversify.config';
import { CheWorkspaceClient } from '../../../services/workspace-client/cheWorkspaceClient';
import { WorkspaceStatus } from '../../../services/helpers/types';
import { createState } from '../../helpers';
import { KeycloakAuthService } from '../../../services/keycloak/auth';
import { deleteLogs, mergeLogs } from '../logs';
import { getErrorMessage } from '../../../services/helpers/getErrorMessage';

const cheWorkspaceClient = container.get(CheWorkspaceClient);
const keycloakAuthService = container.get(KeycloakAuthService);

export interface State {
  isLoading: boolean;
  workspaces: che.Workspace[];
  error?: string;
  // runtime logs
  workspacesLogs: Map<string, string[]>;
}

interface RequestWorkspacesAction {
  type: 'CHE_REQUEST_WORKSPACES';
}

interface ReceiveErrorAction {
  type: 'CHE_RECEIVE_ERROR';
  error: string;
}

interface ReceiveWorkspacesAction {
  type: 'CHE_RECEIVE_WORKSPACES';
  workspaces: che.Workspace[];
}

interface UpdateWorkspaceAction {
  type: 'CHE_UPDATE_WORKSPACE';
  workspace: che.Workspace;
}

interface UpdateWorkspaceStatusAction extends Action {
  type: 'CHE_UPDATE_WORKSPACE_STATUS';
  workspaceId: string;
  status: string;
}

interface UpdateWorkspacesLogsAction extends Action {
  type: 'CHE_UPDATE_WORKSPACES_LOGS';
  workspacesLogs: Map<string, string[]>;
}

interface DeleteWorkspaceLogsAction {
  type: 'CHE_DELETE_WORKSPACE_LOGS';
  workspaceId: string;
}

interface DeleteWorkspaceAction {
  type: 'CHE_DELETE_WORKSPACE';
  workspaceId: string;
}

interface AddWorkspaceAction {
  type: 'CHE_ADD_WORKSPACE';
  workspace: che.Workspace;
}

type KnownAction =
  RequestWorkspacesAction
  | ReceiveErrorAction
  | ReceiveWorkspacesAction
  | UpdateWorkspaceAction
  | DeleteWorkspaceAction
  | AddWorkspaceAction
  | UpdateWorkspaceStatusAction
  | UpdateWorkspacesLogsAction
  | DeleteWorkspaceLogsAction;

export type ResourceQueryParams = {
  'debug-workspace-start': boolean;
  [propName: string]: string | boolean | undefined;
}
export type ActionCreators = {
  requestWorkspaces: () => AppThunk<KnownAction, Promise<void>>;
  requestWorkspace: (workspace: che.Workspace) => AppThunk<KnownAction, Promise<void>>;
  startWorkspace: (workspace: che.Workspace, params?: ResourceQueryParams) => AppThunk<KnownAction, Promise<void>>;
  stopWorkspace: (workspace: che.Workspace) => AppThunk<KnownAction, Promise<void>>;
  deleteWorkspace: (workspace: che.Workspace) => AppThunk<KnownAction, Promise<void>>;
  updateWorkspace: (workspace: che.Workspace) => AppThunk<KnownAction, Promise<void>>;
  createWorkspaceFromDevfile: (
    devfile: che.WorkspaceDevfile,
    namespace: string | undefined,
    infrastructureNamespace: string | undefined,
    attributes: { [key: string]: string } | {},
  ) => AppThunk<KnownAction, Promise<che.Workspace>>;
  deleteWorkspaceLogs: (workspaceId: string) => AppThunk<DeleteWorkspaceLogsAction, void>;
};

type WorkspaceStatusMessageHandler = (message: api.che.workspace.event.WorkspaceStatusEvent) => void;
type EnvironmentOutputMessageHandler = (message: api.che.workspace.event.RuntimeLogEvent) => void;
const subscribedWorkspaceStatusCallbacks = new Map<string, WorkspaceStatusMessageHandler>();
const subscribedEnvironmentOutputCallbacks = new Map<string, EnvironmentOutputMessageHandler>();

function onStatusUpdateReceived(
  workspace: che.Workspace,
  dispatch: ThunkDispatch<State, undefined, UpdateWorkspaceStatusAction | UpdateWorkspacesLogsAction | DeleteWorkspaceLogsAction>,
  message: any) {
  let status: string;
  if (message.error) {
    const workspacesLogs = new Map<string, string[]>();
    workspacesLogs.set(workspace.id, [`Error: Failed to run the workspace: "${message.error}"`]);
    dispatch({
      type: 'CHE_UPDATE_WORKSPACES_LOGS',
      workspacesLogs,
    });
    // ignore an error if start interrupted by owner
    const re = /^Runtime start for identity 'workspace: (?:[\d\w]+), environment: (?:[\w\d]+), ownerId: (?:[-\d\w]+)' is interrupted$/;
    status = re.test(message.error) ? message.status : WorkspaceStatus.ERROR;
  } else {
    status = message.status;
  }
  if (WorkspaceStatus[status]) {
    dispatch({
      type: 'CHE_UPDATE_WORKSPACE_STATUS',
      workspaceId: workspace.id,
      status,
    });
  }
}

function subscribeToStatusChange(
  workspace: che.Workspace,
  dispatch: ThunkDispatch<State, undefined, UpdateWorkspaceStatusAction | UpdateWorkspacesLogsAction | DeleteWorkspaceLogsAction>): void {

  if (subscribedWorkspaceStatusCallbacks.has(workspace.id)) {
    return;
  }
  const callback = (message: any) => onStatusUpdateReceived(workspace, dispatch, message);
  cheWorkspaceClient.jsonRpcMasterApi.subscribeWorkspaceStatus(workspace.id, callback);
  subscribedWorkspaceStatusCallbacks.set(workspace.id, callback);
}

function subscribeToEnvironmentOutput(workspaceId: string, dispatch: ThunkDispatch<State, undefined, UpdateWorkspacesLogsAction | DeleteWorkspaceLogsAction>): void {
  if (subscribedEnvironmentOutputCallbacks.has(workspaceId)) {
    return;
  }
  const callback: EnvironmentOutputMessageHandler = message => {
    if (message.runtimeId?.workspaceId === workspaceId && message.text) {
      const workspacesLogs = new Map<string, string[]>();
      workspacesLogs.set(workspaceId, message.text.split(new RegExp('\\r\\n|\\r|\\n')));
      dispatch({
        type: 'CHE_UPDATE_WORKSPACES_LOGS',
        workspacesLogs,
      });
    }
  };
  dispatch({
    type: 'CHE_DELETE_WORKSPACE_LOGS',
    workspaceId,
  });
  cheWorkspaceClient.jsonRpcMasterApi.subscribeEnvironmentOutput(workspaceId, callback);
  subscribedEnvironmentOutputCallbacks.set(workspaceId, callback);
}

export const actionCreators: ActionCreators = {

  requestWorkspaces: (): AppThunk<KnownAction, Promise<void>> => async (dispatch): Promise<void> => {
    dispatch({ type: 'CHE_REQUEST_WORKSPACES' });

    try {
      const workspaces = await cheWorkspaceClient.restApiClient.getAll<che.Workspace>();

      dispatch({
        type: 'CHE_RECEIVE_WORKSPACES',
        workspaces,
      });

      // Subscribe
      workspaces.forEach(workspace => {
        subscribeToStatusChange(workspace, dispatch);

        if (WorkspaceStatus.STARTING === workspace.status) {
          subscribeToEnvironmentOutput(workspace.id, dispatch);
        }
      });
    } catch (e) {
      const errorMessage = 'Failed to fetch available workspaces, reason: ' + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  requestWorkspace: (workspace: che.Workspace): AppThunk<KnownAction, Promise<void>> => async (dispatch): Promise<void> => {
    dispatch({ type: 'CHE_REQUEST_WORKSPACES' });

    try {
      const update = await cheWorkspaceClient.restApiClient.getById<che.Workspace>(workspace.id);

      if (!subscribedWorkspaceStatusCallbacks.has(update.id)) {
        subscribeToStatusChange(update, dispatch);
      }
      if (update.status === WorkspaceStatus.STARTING) {
        subscribeToEnvironmentOutput(workspace.id, dispatch);
      }
      dispatch({
        type: 'CHE_UPDATE_WORKSPACE',
        workspace: update,
      });
    } catch (e) {
      const errorMessage = `Failed to fetch the workspace with ID: ${workspace.id}, reason: ` + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  startWorkspace: (workspace: che.Workspace, params?: ResourceQueryParams): AppThunk<KnownAction, Promise<void>> => async (dispatch): Promise<void> => {
    try {
      await keycloakAuthService.forceUpdateToken();
      const update = await cheWorkspaceClient.restApiClient.start<che.Workspace>(workspace.id, params);
      dispatch({ type: 'CHE_DELETE_WORKSPACE_LOGS', workspaceId: update.id });
      subscribeToEnvironmentOutput(workspace.id, dispatch);

      dispatch({
        type: 'CHE_UPDATE_WORKSPACE',
        workspace: update,
      });
    } catch (e) {
      const errorMessage = `Failed to start the workspace with ID: ${workspace.id}, reason: ` + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  stopWorkspace: (workspace: che.Workspace): AppThunk<KnownAction, Promise<void>> => async (dispatch): Promise<void> => {
    try {
      await cheWorkspaceClient.restApiClient.stop(workspace.id);
    } catch (e) {
      const errorMessage = `Failed to stop the workspace with ID: ${workspace.id}, reason: ` + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  deleteWorkspace: (workspace: che.Workspace): AppThunk<KnownAction, Promise<void>> => async (dispatch): Promise<void> => {
    try {
      await cheWorkspaceClient.restApiClient.delete(workspace.id);
      dispatch({
        type: 'CHE_DELETE_WORKSPACE_LOGS',
        workspaceId: workspace.id,
      });
      dispatch({
        type: 'CHE_DELETE_WORKSPACE',
        workspaceId: workspace.id,
      });
    } catch (e) {
      const errorMessage = `Failed to delete the workspace with ID: ${workspace.id}, reason: ` + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  updateWorkspace: (workspace: che.Workspace): AppThunk<KnownAction, Promise<void>> => async (dispatch): Promise<void> => {
    dispatch({ type: 'CHE_REQUEST_WORKSPACES' });

    try {
      const updatedWorkspace = await cheWorkspaceClient.restApiClient.update<che.Workspace>(workspace.id, workspace as api.che.workspace.Workspace);
      dispatch({
        type: 'CHE_UPDATE_WORKSPACE',
        workspace: updatedWorkspace
      });
    } catch (e) {
      const errorMessage = `Failed to update the workspace with ID: ${workspace.id}, reason: ` + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  createWorkspaceFromDevfile: (
    devfile: che.WorkspaceDevfile,
    namespace: string | undefined,
    infrastructureNamespace: string | undefined,
    attributes: { [key: string]: string } = {},
  ): AppThunk<KnownAction, Promise<che.Workspace>> => async (dispatch): Promise<che.Workspace> => {
    dispatch({ type: 'CHE_REQUEST_WORKSPACES' });
    try {
      const param = { attributes, namespace, infrastructureNamespace };
      const workspace = await cheWorkspaceClient.restApiClient.create<che.Workspace>(devfile, param);

      // Subscribe
      subscribeToStatusChange(workspace, dispatch);

      dispatch({
        type: 'CHE_ADD_WORKSPACE',
        workspace,
      });
      return workspace;
    } catch (e) {
      const errorMessage = 'Failed to create a new workspace from the devfile, reason: ' + getErrorMessage(e);
      dispatch({
        type: 'CHE_RECEIVE_ERROR',
        error: errorMessage,
      });
      throw errorMessage;
    }
  },

  deleteWorkspaceLogs: (workspaceId: string): AppThunk<DeleteWorkspaceLogsAction, void> => (dispatch): void => {
    dispatch({ type: 'CHE_DELETE_WORKSPACE_LOGS', workspaceId });
  },

};

const unloadedState: State = {
  workspaces: [],
  isLoading: false,

  workspacesLogs: new Map<string, string[]>(),
};

export const reducer: Reducer<State> = (state: State | undefined, action: KnownAction): State => {
  if (state === undefined) {
    return unloadedState;
  }

  switch (action.type) {
    case 'CHE_REQUEST_WORKSPACES':
      return createState(state, {
        isLoading: true,
        error: undefined,
      });
    case 'CHE_RECEIVE_WORKSPACES':
      return createState(state, {
        isLoading: false,
        workspaces: action.workspaces,
      });
    case 'CHE_RECEIVE_ERROR':
      return createState(state, {
        isLoading: false,
        error: action.error,
      });
    case 'CHE_UPDATE_WORKSPACE':
      return createState(state, {
        isLoading: false,
        workspaces: state.workspaces.map(workspace => workspace.id === action.workspace.id ? action.workspace : workspace),
      });
    case 'CHE_UPDATE_WORKSPACE_STATUS':
      return createState(state, {
        workspaces: state.workspaces.map(workspace => {
          if (workspace.id === action.workspaceId) {
            workspace.status = action.status;
          }
          return workspace;
        }),
      });
    case 'CHE_ADD_WORKSPACE':
      return createState(state, {
        workspaces: state.workspaces.concat([action.workspace]),
      });
    case 'CHE_DELETE_WORKSPACE':
      return createState(state, {
        isLoading: false,
        workspaces: state.workspaces.filter(workspace => workspace.id !== action.workspaceId),
      });
    case 'CHE_UPDATE_WORKSPACES_LOGS':
      return createState(state, {
        workspacesLogs: mergeLogs(state.workspacesLogs, action.workspacesLogs),
      });
    case 'CHE_DELETE_WORKSPACE_LOGS':
      return createState(state, {
        workspacesLogs: deleteLogs(state.workspacesLogs, action.workspaceId),
      });
    default:
      return state;
  }

};
