import areEqual from 'fast-deep-equal';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/lib/function';
import * as TE from 'fp-ts/TaskEither';
import { readdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import {
	WebviewViewProvider,
	WebviewView,
	ExtensionContext,
	commands,
	Uri,
	window,
	workspace,
} from 'vscode';

import { WebviewResolver } from './WebviewResolver';
import { CodemodHash, WebviewMessage, WebviewResponse } from './webviewEvents';
import { MessageBus, MessageKind } from '../messageBus';
import { Store } from '../../data';
import { actions } from '../../data/slice';
import { EngineService } from '../engineService';
import { selectMainWebviewViewProps } from '../../selectors/selectMainWebviewViewProps';
import { createIssueResponseCodec } from '../../github/types';
import { SEARCH_PARAMS_KEYS } from '../../extension';
import axios from 'axios';
import { UserService } from '../userService';
import {
	CodemodNodeHashDigest,
	selectCodemodArguments,
} from '../../selectors/selectCodemodTree';
import { isNeitherNullNorUndefined } from '../../utilities';

const X_INTUITA_ACCESS_TOKEN = 'X-Intuita-Access-Token'.toLocaleLowerCase();

export const validateAccessToken = async (
	accessToken: string,
): Promise<boolean> => {
	try {
		const response = await axios.post(
			'https://telemetry.intuita.io/validateAccessToken',
			{},
			{
				headers: {
					[X_INTUITA_ACCESS_TOKEN]: accessToken,
				},
				timeout: 5000,
			},
		);

		return response.status === 200;
	} catch (error) {
		if (!axios.isAxiosError(error)) {
			console.error(error);
		}

		return false;
	}
};

export const createIssue = async (
	title: string,
	body: string,
	accessToken: string,
	onSuccess: () => void,
	onFail: () => Promise<void>,
): Promise<{ status: number; html_url: string | null }> => {
	// call API to create Github Issue
	const codemodRegistryRepo =
		'https://github.com/codemod-com/codemod-registry';
	const result = await axios.post(
		'https://telemetry.intuita.io/sourceControl/github/issues',
		{
			title,
			body,
			repo: codemodRegistryRepo,
		},
		{
			headers: {
				[X_INTUITA_ACCESS_TOKEN]: accessToken,
			},
		},
	);
	if (result.status !== 200) {
		await onFail();
		return { status: result.status, html_url: null };
	}

	const { data } = result;

	const validation = createIssueResponseCodec.decode(data);

	if (validation._tag === 'Left') {
		await onFail();
		window.showErrorMessage('Creating Github issue failed.');
		return { status: 406, html_url: null };
	}

	onSuccess();

	const decision = await window.showInformationMessage(
		'Github issue is successfully created.',
		'See issue in Github',
	);
	const { html_url } = validation.right;
	if (decision === 'See issue in Github') {
		commands.executeCommand('intuita.redirect', html_url);
	}
	return {
		status: 200,
		html_url,
	};
};

const routeUserToStudioToAuthenticate = async () => {
	const result = await window.showInformationMessage(
		'To report issues, sign in to Intuita.',
		{ modal: true },
		'Sign in with Github',
	);

	if (result !== 'Sign in with Github') {
		return;
	}

	const searchParams = new URLSearchParams();

	searchParams.set(SEARCH_PARAMS_KEYS.COMMAND, 'accessTokenRequestedByVSCE');

	const url = new URL('https://codemod.studio');
	url.search = searchParams.toString();

	commands.executeCommand('intuita.redirect', url);
};

const getCompletionItems = (path: string) =>
	pipe(parsePath(path), ({ dir, base }) =>
		pipe(
			readDir(dir),
			TE.map((paths) => toCompletions(paths, dir, base)),
		),
	);

const readDir = (path: string): TE.TaskEither<Error, string[]> =>
	TE.tryCatch(
		() => readdir(path),
		(reason) => new Error(String(reason)),
	);
// parsePath should be IO?
const parsePath = (path: string): { dir: string; base: string } =>
	path.endsWith('/') ? { dir: path, base: '' } : parse(path);

const toCompletions = (paths: string[], dir: string, base: string) =>
	paths.filter((path) => path.startsWith(base)).map((c) => join(dir, c));

export class MainViewProvider implements WebviewViewProvider {
	private __view: WebviewView | null = null;
	private __webviewResolver: WebviewResolver;
	private __autocompleteItems: string[] = [];
	private __executionQueue: ReadonlyArray<CodemodHash> = [];

	constructor(
		context: ExtensionContext,
		private readonly __userService: UserService,
		private readonly __engineService: EngineService,
		private readonly __messageBus: MessageBus,
		private readonly __rootUri: Uri | null,
		private readonly __store: Store,
	) {
		this.__webviewResolver = new WebviewResolver(context.extensionUri);

		this.__messageBus.subscribe(MessageKind.showProgress, (message) => {
			if (message.codemodHash === null) {
				return;
			}

			this.__postMessage({
				kind: 'webview.global.setCodemodExecutionProgress',
				codemodHash: message.codemodHash,
				progressKind: message.progressKind,
				totalFileNumber: message.totalFileNumber,
				processedFileNumber: message.processedFileNumber,
			});
		});

		this.__messageBus.subscribe(MessageKind.codemodSetExecuted, () => {
			this.__postMessage({
				kind: 'webview.global.codemodExecutionHalted',
			});
		});

		this.__messageBus.subscribe(MessageKind.executeCodemodSet, () => {
			this.__store.dispatch(actions.collapseResultsPanel(false));
			this.__store.dispatch(actions.collapseChangeExplorerPanel(false));
		});

		this.__messageBus.subscribe(
			MessageKind.executionQueueChange,
			(message) => {
				this.__executionQueue = message.queuedCodemodHashes;
				const props = this.__buildProps();

				this.__postMessage({
					kind: 'webview.main.setProps',
					props: props,
				});
			},
		);

		let prevProps = this.__buildProps();

		this.__store.subscribe(async () => {
			const nextProps = this.__buildProps();
			if (areEqual(prevProps, nextProps)) {
				return;
			}

			if (
				nextProps !== null &&
				prevProps?.activeTabId !== nextProps.activeTabId &&
				nextProps.activeTabId === 'codemodRuns' &&
				!nextProps.clearingInProgress
			) {
				this.__messageBus.publish({
					kind: MessageKind.loadHomeDirectoryData,
				});
			}

			prevProps = nextProps;

			this.__postMessage({
				kind: 'webview.main.setProps',
				props: nextProps,
			});
		});
	}

	public isVisible(): boolean {
		return this.__view?.visible ?? false;
	}

	public resolveWebviewView(webviewView: WebviewView): void | Thenable<void> {
		this.__resolveWebview(webviewView);

		this.__view = webviewView;

		this.__view.webview.onDidReceiveMessage(this.__onDidReceiveMessage);

		this.__messageBus.publish({
			kind: MessageKind.mainWebviewViewVisibilityChange,
		});

		this.__view.onDidChangeVisibility(() => {
			this.__messageBus.publish({
				kind: MessageKind.mainWebviewViewVisibilityChange,
			});

			if (this.__view?.visible) {
				this.__resolveWebview(this.__view);
			}
		});
	}

	private __postMessage(message: WebviewMessage) {
		this.__view?.webview.postMessage(message);
	}

	private __resolveWebview(webviewView: WebviewView) {
		this.__webviewResolver.resolveWebview(
			webviewView.webview,
			'main',
			JSON.stringify(this.__buildProps()),
			'mainWebviewViewProps',
		);
	}

	private __buildProps() {
		return selectMainWebviewViewProps(
			this.__store.getState(),
			this.__rootUri,
			this.__autocompleteItems,
			this.__executionQueue,
		);
	}

	private __onDidReceiveMessage = async (message: WebviewResponse) => {
		if (message.kind === 'webview.command') {
			commands.executeCommand(
				message.value.command,
				...(message.value.arguments ?? []),
			);
		}

		if (message.kind === 'webview.campaignManager.setSelectedCaseHash') {
			this.__store.dispatch(
				actions.setSelectedCaseHash(message.caseHash),
			);
		}

		if (message.kind === 'webview.global.discardSelected') {
			commands.executeCommand(
				'intuita.discardJobs',
				message.caseHashDigest,
			);
		}

		if (message.kind === 'webview.global.showInformationMessage') {
			window.showInformationMessage(message.value);
		}

		if (message.kind === 'webview.global.applySelected') {
			commands.executeCommand(
				'intuita.sourceControl.saveStagedJobsToTheFileSystem',
				message.caseHashDigest,
			);
		}

		if (message.kind === 'webview.main.setActiveTabId') {
			this.__store.dispatch(actions.setActiveTabId(message.activeTabId));
		}

		if (
			message.kind ===
			'webview.main.setCodemodDiscoveryPanelGroupSettings'
		) {
			this.__store.dispatch(
				actions.setCodemodDiscoveryPanelGroupSettings(
					message.panelGroupSettings,
				),
			);
		}

		if (message.kind === 'webview.main.setCodemodRunsPanelGroupSettings') {
			this.__store.dispatch(
				actions.setCodemodRunsPanelGroupSettings(
					message.panelGroupSettings,
				),
			);
		}

		if (message.kind === 'webview.main.setToaster') {
			this.__store.dispatch(actions.setToaster(message.value));
		}

		if (message.kind === 'webview.main.signOut') {
			commands.executeCommand('intuita.signOut');
		}

		if (message.kind === 'webview.main.removePrivateCodemod') {
			commands.executeCommand(
				'intuita.removePrivateCodemod',
				message.hashDigest,
			);
		}

		if (message.kind === 'webview.global.flipSelectedExplorerNode') {
			this.__store.dispatch(
				actions.flipSelectedExplorerNode([
					message.caseHashDigest,
					message.explorerNodeHashDigest,
				]),
			);
		}

		if (message.kind === 'webview.global.flipCollapsibleExplorerNode') {
			this.__store.dispatch(
				actions.flipCollapsibleExplorerNode([
					message.caseHashDigest,
					message.explorerNodeHashDigest,
				]),
			);
		}

		if (message.kind === 'webview.global.focusExplorerNode') {
			this.__store.dispatch(
				actions.focusExplorerNode([
					message.caseHashDigest,
					message.explorerNodeHashDigest,
				]),
			);
		}

		if (message.kind === 'webview.global.setChangeExplorerSearchPhrase') {
			this.__store.dispatch(
				actions.setChangeExplorerSearchPhrase([
					message.caseHashDigest,
					message.searchPhrase,
				]),
			);
		}

		if (message.kind === 'webview.codemodList.haltCodemodExecution') {
			this.__engineService.shutdownEngines();
		}

		if (message.kind === 'webview.codemodList.dryRunCodemod') {
			if (this.__rootUri === null) {
				window.showWarningMessage('No active workspace is found.');
				return;
			}

			const hashDigest = message.value;
			this.__store.dispatch(actions.setRecentCodemodHashes(hashDigest));

			const state = this.__store.getState().codemodDiscoveryView;
			const executionPath =
				state.executionPaths[hashDigest] ?? this.__rootUri.fsPath;

			if (executionPath === null) {
				return;
			}

			const uri = Uri.file(executionPath);

			// if missing some required arguments, open arguments popup
			const argumentsSpecified = selectCodemodArguments(
				this.__store.getState(),
				hashDigest as unknown as CodemodNodeHashDigest,
			).every(
				({ required, value }) =>
					!required ||
					(isNeitherNullNorUndefined(value) && value !== ''),
			);

			if (!argumentsSpecified) {
				this.__store.dispatch(
					actions.setCodemodArgumentsPopupHashDigest(
						hashDigest as unknown as CodemodNodeHashDigest,
					),
				);
				return;
			}

			commands.executeCommand('intuita.executeCodemod', uri, hashDigest);
		}

		if (message.kind === 'webview.codemodList.dryRunPrivateCodemod') {
			if (this.__rootUri === null) {
				window.showWarningMessage('No active workspace is found.');
				return;
			}

			const hashDigest = message.value;
			this.__store.dispatch(actions.setRecentCodemodHashes(hashDigest));

			const state = this.__store.getState().codemodDiscoveryView;
			const executionPath =
				state.executionPaths[hashDigest] ?? this.__rootUri.fsPath;

			if (executionPath === null) {
				return;
			}

			const uri = Uri.file(executionPath);

			commands.executeCommand(
				'intuita.executePrivateCodemod',
				uri,
				hashDigest,
				message.name,
			);
		}

		if (message.kind === 'webview.codemodList.updatePathToExecute') {
			await this.updateExecutionPath(message.value);
		}

		if (message.kind === 'webview.global.showWarningMessage') {
			window.showWarningMessage(message.value);
		}

		if (message.kind === 'webview.codemodList.codemodPathChange') {
			const completionItemsOrError = await getCompletionItems(
				message.codemodPath,
			)();

			pipe(
				completionItemsOrError,
				E.fold(
					() => (this.__autocompleteItems = []),
					(autocompleteItems) =>
						(this.__autocompleteItems = autocompleteItems),
				),
			);

			this.__postMessage({
				kind: 'webview.main.setProps',
				props: this.__buildProps(),
			});
		}

		if (message.kind === 'webview.global.flipCodemodHashDigest') {
			this.__store.dispatch(
				actions.flipCodemodHashDigest(message.codemodNodeHashDigest),
			);
		}

		if (message.kind === 'webview.global.selectCodemodNodeHashDigest') {
			this.__store.dispatch(
				actions.setFocusedCodemodHashDigest(
					message.selectedCodemodNodeHashDigest,
				),
			);
		}

		if (message.kind === 'webview.global.setCodemodSearchPhrase') {
			this.__store.dispatch(
				actions.setCodemodSearchPhrase(message.searchPhrase),
			);
		}

		if (message.kind === 'webview.global.collapseResultsPanel') {
			this.__store.dispatch(
				actions.collapseResultsPanel(message.collapsed),
			);
		}

		if (message.kind === 'webview.global.collapseChangeExplorerPanel') {
			this.__store.dispatch(
				actions.collapseChangeExplorerPanel(message.collapsed),
			);
		}

		if (message.kind === 'webview.global.collapsePublicRegistryPanel') {
			this.__store.dispatch(
				actions.collapsePublicRegistryPanel(message.collapsed),
			);
		}

		if (message.kind === 'webview.global.collapsePrivateRegistryPanel') {
			this.__store.dispatch(
				actions.collapsePrivateRegistryPanel(message.collapsed),
			);
		}

		if (message.kind === 'webview.sourceControl.createIssue') {
			const accessToken = this.__userService.getLinkedToken();

			const { title, body } = message.data;

			if (accessToken === null) {
				this.__store.dispatch(
					actions.setSourceControlTabProps({
						kind: 'ISSUE_CREATION_WAITING_FOR_AUTH',
						title,
						body,
					}),
				);
				await routeUserToStudioToAuthenticate();
				return;
			}

			// call API to create Github Issue
			const onSuccess = () => {
				this.__store.dispatch(
					actions.setSourceControlTabProps({ kind: 'IDLENESS' }),
				);
				this.__store.dispatch(actions.setActiveTabId('codemodRuns'));
			};

			const onFail = async () => {
				this.__userService.unlinkUserIntuitaAccount();
				this.__store.dispatch(
					actions.setSourceControlTabProps({
						kind: 'ISSUE_CREATION_WAITING_FOR_AUTH',
						title,
						body,
					}),
				);
				await routeUserToStudioToAuthenticate();
			};

			this.__store.dispatch(
				actions.setSourceControlTabProps({
					kind: 'WAITING_FOR_ISSUE_CREATION_API_RESPONSE',
					title,
					body,
				}),
			);
			await createIssue(title, body, accessToken, onSuccess, onFail);
		}

		if (
			message.kind === 'webview.global.setCodemodArgumentsPopupHashDigest'
		) {
			this.__store.dispatch(
				actions.setCodemodArgumentsPopupHashDigest(message.hashDigest),
			);
		}

		if (message.kind === 'webview.global.setCodemodArgument') {
			this.__store.dispatch(
				actions.setCodemodArgument({
					hashDigest: message.hashDigest,
					name: message.name,
					value: message.value,
				}),
			);
		}
	};

	public updateExecutionPath = async ({
		newPath,
		codemodHash,
		errorMessage,
		warningMessage,
		revertToPrevExecutionIfInvalid,
		fromVSCodeCommand,
	}: {
		newPath: string;
		codemodHash: CodemodHash;
		errorMessage: string | null;
		warningMessage: string | null;
		revertToPrevExecutionIfInvalid: boolean;
		fromVSCodeCommand?: boolean;
	}) => {
		if (this.__rootUri === null) {
			window.showWarningMessage('No active workspace is found.');
			return;
		}

		const state = this.__store.getState().codemodDiscoveryView;
		const persistedExecutionPath = state.executionPaths[codemodHash];

		const oldExecutionPath = persistedExecutionPath ?? null;

		try {
			await workspace.fs.stat(Uri.file(newPath));

			this.__store.dispatch(
				actions.setExecutionPath({ codemodHash, path: newPath }),
			);

			if (newPath !== oldExecutionPath && !fromVSCodeCommand) {
				window.showInformationMessage(
					'Successfully updated the execution path.',
				);
			}
		} catch (e) {
			if (errorMessage !== null) {
				window.showErrorMessage(errorMessage);
			}
			if (warningMessage !== null) {
				window.showWarningMessage(warningMessage);
			}

			if (oldExecutionPath === null) {
				return;
			}

			if (revertToPrevExecutionIfInvalid) {
				this.__store.dispatch(
					actions.setExecutionPath({
						codemodHash,
						path: oldExecutionPath,
					}),
				);
			} else {
				this.__store.dispatch(
					actions.setExecutionPath({
						codemodHash,
						path: oldExecutionPath,
					}),
				);
			}
		}
	};
}
