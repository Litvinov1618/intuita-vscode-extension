import * as vscode from 'vscode';
import TelemetryReporter from '@vscode/extension-telemetry';
import { getConfiguration } from './configuration';
import { buildContainer } from './container';
import { Command, MessageBus, MessageKind } from './components/messageBus';
import { JobManager } from './components/jobManager';
import { FileService } from './components/fileService';
import { CaseHash, caseHashCodec } from './cases/types';
import { DownloadService } from './components/downloadService';
import { FileSystemUtilities } from './components/fileSystemUtilities';
import { EngineService } from './components/engineService';
import { BootstrapExecutablesService } from './components/bootstrapExecutablesService';
import { buildCaseHash } from './telemetry/hashes';
import { IntuitaTextDocumentContentProvider } from './components/textDocumentContentProvider';
import { CodemodHash } from './packageJsonAnalyzer/types';
import { VscodeTelemetry } from './telemetry/vscodeTelemetry';
import prettyReporter from 'io-ts-reporters';
import { ErrorWebviewProvider } from './components/webview/ErrorWebviewProvider';
import {
	MainViewProvider,
	createIssue,
	validateAccessToken,
} from './components/webview/MainProvider';
import { buildStore } from './data';
import { actions } from './data/slice';
import { IntuitaPanelProvider } from './components/webview/IntuitaPanelProvider';
import { CaseManager } from './cases/caseManager';
import { CodemodDescriptionProvider } from './components/webview/CodemodDescriptionProvider';
import { selectExplorerTree } from './selectors/selectExplorerTree';
import {
	CodemodNodeHashDigest,
	selectCodemodArguments,
} from './selectors/selectCodemodTree';
import { buildHash, isNeitherNullNorUndefined } from './utilities';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { existsSync, rmSync } from 'fs';
import {
	CodemodConfig,
	PIRANHA_LANGUAGES,
	parsePiranhaLanguage,
} from './data/codemodConfigSchema';
import { parsePrivateCodemodsEnvelope } from './data/privateCodemodsEnvelopeSchema';
import { GlobalStateTokenStorage, UserService } from './components/userService';
import { HomeDirectoryService } from './data/readHomeDirectoryCases';
import { isLeft } from 'fp-ts/lib/Either';
import { createClearStateCommand } from './commands/clearStateCommand';

export const enum SEARCH_PARAMS_KEYS {
	ENGINE = 'engine',
	BEFORE_SNIPPET = 'beforeSnippet',
	AFTER_SNIPPET = 'afterSnippet',
	CODEMOD_SOURCE = 'codemodSource',
	CODEMOD_NAME = 'codemodName',
	COMMAND = 'command',
	COMPRESSED_SHAREABLE_CODEMOD = 'c',
	CODEMOD_HASH_DIGEST = 'chd',
	ACCESS_TOKEN = 'accessToken',
}

const messageBus = new MessageBus();

export async function activate(context: vscode.ExtensionContext) {
	const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri ?? null;

	messageBus.setDisposables(context.subscriptions);

	const { store } = await buildStore(context.workspaceState);

	const globalStateTokenStorage = new GlobalStateTokenStorage(
		context.globalState,
	);
	const userService = new UserService(globalStateTokenStorage);

	const accessToken = userService.getLinkedToken();
	if (accessToken !== null) {
		const valid = await validateAccessToken(accessToken);
		vscode.commands.executeCommand('setContext', 'intuita.signedIn', valid);

		if (!valid) {
			userService.unlinkUserIntuitaAccount();
			const decision = await vscode.window.showInformationMessage(
				'You are signed out because your session has expired.',
				'Do you want to sign in again?',
			);
			if (decision === 'Do you want to sign in again?') {
				const searchParams = new URLSearchParams();

				searchParams.set(
					SEARCH_PARAMS_KEYS.COMMAND,
					'accessTokenRequestedByVSCE',
				);

				const url = new URL('https://codemod.studio');
				url.search = searchParams.toString();

				vscode.commands.executeCommand('intuita.redirect', url);
			}
		}
	}

	const configurationContainer = buildContainer(getConfiguration());

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(() => {
			configurationContainer.set(getConfiguration());
		}),
	);

	const fileService = new FileService(messageBus);

	const jobManager = new JobManager(fileService, messageBus, store);

	new CaseManager(messageBus, store);

	const fileSystemUtilities = new FileSystemUtilities(vscode.workspace.fs);

	const downloadService = new DownloadService(
		vscode.workspace.fs,
		fileSystemUtilities,
	);

	const engineService = new EngineService(
		configurationContainer,
		messageBus,
		vscode.workspace.fs,
		store,
	);

	new BootstrapExecutablesService(
		downloadService,
		context.globalStorageUri,
		vscode.workspace.fs,
		messageBus,
	);

	const intuitaTextDocumentContentProvider =
		new IntuitaTextDocumentContentProvider();

	const telemetryKey = 'd9f8ad27-50df-46e3-8acf-81ea279c8444';
	const vscodeTelemetry = new VscodeTelemetry(
		new TelemetryReporter(telemetryKey),
		messageBus,
	);

	const mainViewProvider = new MainViewProvider(
		context,
		userService,
		engineService,
		messageBus,
		rootUri,
		store,
	);

	const mainView = vscode.window.registerWebviewViewProvider(
		'intuitaMainView',
		mainViewProvider,
	);

	const codemodDescriptionProvider = new CodemodDescriptionProvider(
		vscode.workspace.fs,
	);

	new IntuitaPanelProvider(
		context.extensionUri,
		store,
		mainViewProvider,
		messageBus,
		codemodDescriptionProvider,
		rootUri?.fsPath ?? null,
		jobManager,
	);

	context.subscriptions.push(mainView);

	const errorWebviewProvider = new ErrorWebviewProvider(
		context,
		messageBus,
		store,
		mainViewProvider,
	);

	let syncRegistryIntervalId: NodeJS.Timer | null = null;

	vscode.window.onDidChangeWindowState((event) => {
		if (syncRegistryIntervalId) {
			clearInterval(syncRegistryIntervalId);
			syncRegistryIntervalId = null;
		}

		if (!event.focused) {
			return;
		}

		syncRegistryIntervalId = setInterval(async () => {
			await engineService.syncRegistry();
		}, 15 * 60 * 1000);
	});
	// this is only used by the intuita panel's webview
	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.redirect', (arg0) => {
			try {
				vscode.env.openExternal(vscode.Uri.parse(arg0));
			} catch (e) {
				vscode.window.showWarningMessage('Invalid URL:' + arg0);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.showIntuitaSettings', () => {
			vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'Intuita',
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.signIn', () => {
			const searchParams = new URLSearchParams();

			searchParams.set(
				SEARCH_PARAMS_KEYS.COMMAND,
				'accessTokenRequestedByVSCE',
			);

			const url = new URL('https://codemod.studio');
			url.search = searchParams.toString();

			vscode.commands.executeCommand('intuita.redirect', url);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.signOut', () => {
			userService.unlinkUserIntuitaAccount();
			vscode.commands.executeCommand(
				'setContext',
				'intuita.signedIn',
				false,
			);
			store.dispatch(
				actions.setToaster({
					toastId: 'signOut',
					containerId: 'primarySidebarToastContainer',
					content: 'Signed out',
					autoClose: 3000,
				}),
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.handleSignedInUser', () => {
			store.dispatch(
				actions.setToaster({
					toastId: 'handleSignedInUser',
					containerId: 'primarySidebarToastContainer',
					content: 'Already signed-in',
					autoClose: 5000,
				}),
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.clearOutputFiles',
			async () => {
				const { storageUri } = context;

				if (!storageUri) {
					console.error('No storage URI, aborting the command.');
					return;
				}

				await engineService.clearOutputFiles(storageUri);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.sourceControl.saveStagedJobsToTheFileSystem',
			async (arg0: unknown) => {
				try {
					store.dispatch(actions.setApplySelectedInProgress(true));

					const validation = caseHashCodec.decode(arg0);

					if (validation._tag === 'Left') {
						throw new Error(
							prettyReporter.report(validation).join('\n'),
						);
					}

					const caseHashDigest = validation.right;

					const state = store.getState();

					if (
						caseHashDigest !== state.codemodRunsTab.selectedCaseHash
					) {
						return;
					}

					const tree = selectExplorerTree(
						state,
						vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
							'',
					);

					if (tree === null) {
						store.dispatch(
							actions.setApplySelectedInProgress(false),
						);
						return;
					}

					const { selectedJobHashes } = tree;

					await jobManager.acceptJobs(new Set(selectedJobHashes));

					store.dispatch(
						actions.clearSelectedExplorerNodes(caseHashDigest),
					);
					store.dispatch(
						actions.clearIndeterminateExplorerNodes(caseHashDigest),
					);

					vscode.commands.executeCommand('workbench.view.scm');
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					vscodeTelemetry.sendError({
						kind: 'failedToExecuteCommand',
						commandName:
							'intuita.sourceControl.saveStagedJobsToTheFileSystem',
					});
					vscode.window.showErrorMessage(message);
				} finally {
					store.dispatch(actions.setApplySelectedInProgress(false));
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.discardJobs', async (arg0) => {
			try {
				const validation = caseHashCodec.decode(arg0);

				if (validation._tag === 'Left') {
					throw new Error(
						prettyReporter.report(validation).join('\n'),
					);
				}

				const caseHashDigest = validation.right;

				const state = store.getState();

				if (caseHashDigest !== state.codemodRunsTab.selectedCaseHash) {
					return;
				}

				const tree = selectExplorerTree(
					state,
					vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
				);

				if (tree === null) {
					return;
				}

				const { selectedJobHashes } = tree;

				jobManager.deleteJobs(selectedJobHashes);

				store.dispatch(
					actions.clearSelectedExplorerNodes(caseHashDigest),
				);
				store.dispatch(
					actions.clearIndeterminateExplorerNodes(caseHashDigest),
				);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(message);

				vscodeTelemetry.sendError({
					kind: 'failedToExecuteCommand',
					commandName: 'intuita.discardJobs',
				});
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.rejectCase', async (arg0) => {
			try {
				const caseHash: string | null =
					typeof arg0 === 'string' ? arg0 : null;

				if (caseHash === null) {
					throw new Error(
						'Did not pass the caseHash into the command.',
					);
				}

				messageBus.publish({
					kind: MessageKind.rejectCase,
					caseHash: caseHash as CaseHash,
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(message);

				vscodeTelemetry.sendError({
					kind: 'failedToExecuteCommand',
					commandName: 'intuita.rejectCase',
				});
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.executeAsCodemod',
			async (codemodUri: vscode.Uri) => {
				try {
					const targetUri =
						vscode.workspace.workspaceFolders?.[0]?.uri ?? null;

					if (targetUri == null) {
						throw new Error('No workspace has been opened.');
					}

					const { storageUri } = context;

					if (!storageUri) {
						throw new Error(
							'No storage URI, aborting the command.',
						);
					}

					const happenedAt = String(Date.now());

					const fileStat = await vscode.workspace.fs.stat(targetUri);
					const targetUriIsDirectory = Boolean(
						fileStat.type & vscode.FileType.Directory,
					);

					messageBus.publish({
						kind: MessageKind.executeCodemodSet,
						command: {
							kind: 'executeLocalCodemod',
							codemodUri,
							name: codemodUri.fsPath,
							codemodHash: null,
						},
						happenedAt,
						caseHashDigest: buildCaseHash(),
						storageUri,
						targetUri,
						targetUriIsDirectory,
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(message);

					vscodeTelemetry.sendError({
						kind: 'failedToExecuteCommand',
						commandName: 'intuita.executeAsCodemod',
					});
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.executeAsPiranhaRule',
			async (configurationUri: vscode.Uri) => {
				const fileStat = await vscode.workspace.fs.stat(
					configurationUri,
				);
				const configurationUriIsDirectory = Boolean(
					fileStat.type & vscode.FileType.Directory,
				);

				if (!configurationUriIsDirectory) {
					throw new Error(
						`To execute a configuration URI as a Piranha rule, it has to be a directory`,
					);
				}

				const targetUri =
					vscode.workspace.workspaceFolders?.[0]?.uri ?? null;

				if (targetUri == null) {
					throw new Error('No workspace has been opened.');
				}

				const { storageUri } = context;

				if (!storageUri) {
					throw new Error('No storage URI, aborting the command.');
				}

				const quickPick =
					(await vscode.window.showQuickPick(PIRANHA_LANGUAGES, {
						title: 'Select the language to run Piranha against',
					})) ?? null;

				if (quickPick == null) {
					throw new Error('You must specify the language');
				}

				const language = parsePiranhaLanguage(quickPick);

				messageBus.publish({
					kind: MessageKind.executeCodemodSet,
					command: {
						kind: 'executePiranhaRule',
						configurationUri,
						language,
						name: configurationUri.fsPath,
					},
					happenedAt: String(Date.now()),
					caseHashDigest: buildCaseHash(),
					storageUri,
					targetUri,
					targetUriIsDirectory: configurationUriIsDirectory,
				});
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.executeCodemod',
			async (targetUri: vscode.Uri, codemodHash: CodemodHash) => {
				try {
					const { storageUri } = context;

					if (!storageUri) {
						throw new Error(
							'No storage URI, aborting the command.',
						);
					}

					const happenedAt = String(Date.now());

					const fileStat = await vscode.workspace.fs.stat(targetUri);
					const targetUriIsDirectory = Boolean(
						fileStat.type & vscode.FileType.Directory,
					);

					const codemod =
						store.getState().codemod.entities[codemodHash] ?? null;

					if (codemod === null) {
						throw new Error(
							'No codemod was found with the provided hash digest.',
						);
					}

					const args = selectCodemodArguments(
						store.getState(),
						codemodHash as unknown as CodemodNodeHashDigest,
					);
					const command: Command =
						codemod.kind === 'piranhaRule'
							? {
									kind: 'executePiranhaRule',
									configurationUri: vscode.Uri.file(
										join(
											homedir(),
											'.intuita',
											createHash('ripemd160')
												.update(codemod.name)
												.digest('base64url'),
										),
									),
									language: codemod.language,
									name: codemod.name,
									arguments: args,
							  }
							: {
									kind: 'executeCodemod',
									codemodHash,
									name: codemod.name,
									arguments: args,
							  };

					store.dispatch(
						actions.setFocusedCodemodHashDigest(
							codemodHash as unknown as CodemodNodeHashDigest,
						),
					);

					messageBus.publish({
						kind: MessageKind.executeCodemodSet,
						command,
						caseHashDigest: buildCaseHash(),
						happenedAt,
						targetUri,
						targetUriIsDirectory,
						storageUri,
					});

					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(message);

					vscodeTelemetry.sendError({
						kind: 'failedToExecuteCommand',
						commandName: 'intuita.executeCodemod',
					});
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.executeCodemodWithinPath',
			async (uriArg: vscode.Uri | null | undefined) => {
				try {
					const { storageUri } = context;

					if (!storageUri) {
						throw new Error(
							'No storage URI, aborting the command.',
						);
					}

					const targetUri =
						uriArg ??
						vscode.window.activeTextEditor?.document.uri ??
						null;

					if (targetUri === null) {
						return;
					}

					const codemodList = Object.values(
						store.getState().codemod.entities,
					).filter(isNeitherNullNorUndefined);

					// order: least recent to most recent
					const top5RecentCodemodHashes =
						store.getState().lastCodemodHashDigests;

					const top5RecentCodemods = codemodList.filter((codemod) =>
						top5RecentCodemodHashes.includes(
							codemod.hashDigest as CodemodHash,
						),
					);

					// order: least recent to most recent
					top5RecentCodemods.sort((a, b) => {
						return (
							top5RecentCodemodHashes.indexOf(
								a.hashDigest as CodemodHash,
							) -
							top5RecentCodemodHashes.indexOf(
								b.hashDigest as CodemodHash,
							)
						);
					});
					const sortedCodemodList = [
						...top5RecentCodemods.reverse(),
						...codemodList.filter(
							(codemod) =>
								!top5RecentCodemodHashes.includes(
									codemod.hashDigest as CodemodHash,
								),
						),
					];

					const quickPickItem =
						(await vscode.window.showQuickPick(
							sortedCodemodList.map(({ name, hashDigest }) => ({
								label: name,
								...(top5RecentCodemodHashes.includes(
									hashDigest as CodemodHash,
								) && { description: '(recent)' }),
							})),
							{
								placeHolder:
									'Pick a codemod to execute over the selected path',
							},
						)) ?? null;

					if (quickPickItem === null) {
						return;
					}

					const codemodEntry =
						sortedCodemodList.find(
							({ name }) => name === quickPickItem.label,
						) ?? null;

					if (codemodEntry === null) {
						throw new Error('Codemod is not selected');
					}

					await mainViewProvider.updateExecutionPath({
						newPath: targetUri.path,
						codemodHash: codemodEntry.hashDigest as CodemodHash,
						fromVSCodeCommand: true,
						errorMessage: null,
						warningMessage: null,
						revertToPrevExecutionIfInvalid: false,
					});

					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);

					store.dispatch(
						actions.setFocusedCodemodHashDigest(
							codemodEntry.hashDigest as unknown as CodemodNodeHashDigest,
						),
					);

					const fileStat = await vscode.workspace.fs.stat(targetUri);
					const targetUriIsDirectory = Boolean(
						fileStat.type & vscode.FileType.Directory,
					);

					const args = selectCodemodArguments(
						store.getState(),
						codemodEntry.hashDigest as unknown as CodemodNodeHashDigest,
					);

					const command: Command =
						codemodEntry.kind === 'piranhaRule'
							? {
									kind: 'executePiranhaRule',
									configurationUri: vscode.Uri.file(
										join(
											homedir(),
											'.intuita',
											createHash('ripemd160')
												.update(codemodEntry.name)
												.digest('base64url'),
										),
									),
									language: codemodEntry.language,
									name: codemodEntry.name,
									arguments: args,
							  }
							: {
									kind: 'executeCodemod',
									codemodHash:
										codemodEntry.hashDigest as CodemodHash,
									name: codemodEntry.name,
									arguments: args,
							  };

					messageBus.publish({
						kind: MessageKind.executeCodemodSet,
						command,
						caseHashDigest: buildCaseHash(),
						happenedAt: String(Date.now()),
						storageUri,
						targetUri,
						targetUriIsDirectory,
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(message);

					vscodeTelemetry.sendError({
						kind: 'failedToExecuteCommand',
						commandName: 'intuita.executeCodemodWithinPath',
					});
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.executePrivateCodemod',
			async (
				targetUri: vscode.Uri,
				codemodHash: CodemodHash,
				codemodName: string,
			) => {
				try {
					const { storageUri } = context;

					if (!storageUri) {
						throw new Error(
							'No storage URI, aborting the command.',
						);
					}

					const fileStat = await vscode.workspace.fs.stat(targetUri);
					const targetUriIsDirectory = Boolean(
						fileStat.type & vscode.FileType.Directory,
					);

					store.dispatch(
						actions.setFocusedCodemodHashDigest(
							codemodHash as unknown as CodemodNodeHashDigest,
						),
					);

					const codemodUri = vscode.Uri.file(
						join(homedir(), '.intuita', codemodHash, 'index.ts'),
					);

					messageBus.publish({
						kind: MessageKind.executeCodemodSet,
						command: {
							kind: 'executeLocalCodemod',
							codemodUri,
							name: codemodName,
							codemodHash,
						},
						happenedAt: String(Date.now()),
						caseHashDigest: buildCaseHash(),
						storageUri,
						targetUri,
						targetUriIsDirectory,
					});

					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(message);

					vscodeTelemetry.sendError({
						kind: 'failedToExecuteCommand',
						commandName: 'intuita.executeImportedModOnPath',
					});
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.clearState',
			createClearStateCommand({ fileService, store }),
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('intuita.stopStateClearing', () => {
			store.dispatch(actions.onStateCleared());
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.removePrivateCodemod',
			(arg0: unknown) => {
				try {
					const hashDigest: string | null =
						typeof arg0 === 'string' ? arg0 : null;

					if (hashDigest === null) {
						throw new Error(
							'Did not pass the hashDigest into the command.',
						);
					}
					const codemodPath = join(homedir(), '.intuita', hashDigest);
					if (existsSync(codemodPath)) {
						rmSync(codemodPath, { recursive: true, force: true });
					}

					const codemodNamesPath = join(
						homedir(),
						'.intuita',
						'privateCodemodNames.json',
					);
					if (existsSync(codemodNamesPath)) {
						rmSync(codemodNamesPath);
					}

					store.dispatch(
						actions.removePrivateCodemods([
							hashDigest as CodemodHash,
						]),
					);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					vscode.window.showErrorMessage(message);

					vscodeTelemetry.sendError({
						kind: 'failedToExecuteCommand',
						commandName: 'intuita.removePrivateCodemod',
					});
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.sendAsBeforeSnippet',
			async () => {
				const { activeTextEditor } = vscode.window;

				if (!activeTextEditor) {
					console.error(
						'No active text editor, sendAsBeforeSnippet will not be executed',
					);
					return;
				}

				const selection = activeTextEditor.selection;
				const text = activeTextEditor.document.getText(selection);

				const beforeSnippet = Buffer.from(text).toString('base64url');

				const uri = vscode.Uri.parse(
					`https://codemod.studio?beforeSnippet=${beforeSnippet}`,
				);

				await vscode.env.openExternal(uri);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'intuita.sendAsAfterSnippet',
			async () => {
				const { activeTextEditor } = vscode.window;

				if (!activeTextEditor) {
					console.error(
						'No active text editor, sendAsAfterSnippet will not be executed',
					);
					return;
				}

				const selection = activeTextEditor.selection;
				const text = activeTextEditor.document.getText(selection);

				const afterSnippet = Buffer.from(text).toString('base64url');

				const uri = vscode.Uri.parse(
					`https://codemod.studio?afterSnippet=${afterSnippet}`,
				);

				await vscode.env.openExternal(uri);
			},
		),
	);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			'intuita',
			intuitaTextDocumentContentProvider,
		),
	);

	context.subscriptions.push(
		vscode.window.registerUriHandler({
			handleUri: async (uri) => {
				const urlParams = new URLSearchParams(uri.query);
				const codemodSource = urlParams.get(
					SEARCH_PARAMS_KEYS.CODEMOD_SOURCE,
				);

				const codemodHashDigest = urlParams.get(
					SEARCH_PARAMS_KEYS.CODEMOD_HASH_DIGEST,
				);
				const accessToken = urlParams.get(
					SEARCH_PARAMS_KEYS.ACCESS_TOKEN,
				);
				const state = store.getState();

				const [hash, casesString] = uri.toString().split('/').reverse();
				const codemodRunCaseHash =
					casesString === 'cases' && hash ? hash : null;

				// user is routed to a specific dry run case
				if (codemodRunCaseHash !== null) {
					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);

					const validation = caseHashCodec.decode(codemodRunCaseHash);
					if (isLeft(validation)) {
						throw new Error(
							prettyReporter.report(validation).join('\n'),
						);
					}

					messageBus.publish({
						kind: MessageKind.loadHomeDirectoryCase,
						caseHashDigest: validation.right,
					});
				}

				// user is exporting codemod from studio into extension
				if (codemodSource !== null) {
					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);
					const codemodSourceBuffer = Buffer.from(
						codemodSource,
						'base64url',
					);

					const globalStoragePath = join(homedir(), '.intuita');
					const codemodHash = randomBytes(27).toString('base64url');
					const codemodDirectoryPath = join(
						globalStoragePath,
						codemodHash,
					);
					await mkdir(codemodDirectoryPath, { recursive: true });

					const buildConfigPath = join(
						codemodDirectoryPath,
						'config.json',
					);

					await writeFile(
						buildConfigPath,
						JSON.stringify({
							schemaVersion: '1.0.0',
							engine: 'jscodeshift',
						} satisfies CodemodConfig),
					);

					const buildIndexPath = join(
						codemodDirectoryPath,
						'index.ts',
					);

					await writeFile(buildIndexPath, codemodSourceBuffer);

					const newPrivateCodemodNames = [];
					const privateCodemodNamesPath = join(
						globalStoragePath,
						'privateCodemodNames.json',
					);
					if (existsSync(privateCodemodNamesPath)) {
						const privateCodemodNamesJSON = await readFile(
							privateCodemodNamesPath,
							{
								encoding: 'utf8',
							},
						);
						const privateCodemodNames = JSON.parse(
							privateCodemodNamesJSON,
						);

						const { names } =
							parsePrivateCodemodsEnvelope(privateCodemodNames);

						newPrivateCodemodNames.push(...names);
					}
					newPrivateCodemodNames.push(codemodHash);
					await Promise.all([
						writeFile(
							privateCodemodNamesPath,
							JSON.stringify({
								names: newPrivateCodemodNames,
							}),
						),
						writeFile(
							join(codemodDirectoryPath, 'urlParams.json'),
							JSON.stringify({
								urlParams: uri.query,
							}),
						),
					]);

					await engineService.fetchPrivateCodemods();

					store.dispatch(
						actions.setFocusedCodemodHashDigest(
							codemodHash as unknown as CodemodNodeHashDigest,
						),
					);
				}
				// user is opening a deep link to a specific codemod
				else if (codemodHashDigest !== null) {
					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);

					// Expand collapsed parent directories of the relevant codemod
					if (codemodHashDigest !== null) {
						const privateCodemod =
							state.privateCodemods.entities[codemodHashDigest] ??
							null;

						if (privateCodemod !== null) {
							store.dispatch(
								actions.setFocusedCodemodHashDigest(
									codemodHashDigest as unknown as CodemodNodeHashDigest,
								),
							);
							return;
						}

						const codemod =
							state.codemod.entities[codemodHashDigest] ?? null;
						if (codemod === null) {
							return;
						}
						const { name } = codemod;
						const sep = name.indexOf('/') !== -1 ? '/' : ':';

						const pathParts = name
							.split(sep)
							.filter((part) => part !== '');

						if (pathParts.length === 0) {
							return;
						}

						pathParts.forEach((name, idx) => {
							const path = pathParts.slice(0, idx + 1).join(sep);

							if (idx === pathParts.length - 1) {
								return;
							}

							const parentHashDigest = buildHash(
								[path, name].join('_'),
							) as CodemodNodeHashDigest;

							if (
								state.codemodDiscoveryView.expandedNodeHashDigests.includes(
									parentHashDigest,
								)
							) {
								return;
							}

							store.dispatch(
								actions.flipCodemodHashDigest(parentHashDigest),
							);
						});
					}

					if (state.codemodDiscoveryView.searchPhrase.length > 0) {
						store.dispatch(actions.setCodemodSearchPhrase(''));
					}

					store.dispatch(
						actions.setFocusedCodemodHashDigest(
							codemodHashDigest as unknown as CodemodNodeHashDigest,
						),
					);
				} else if (accessToken !== null) {
					const routeUserToStudioToAuthenticate = async () => {
						const result = await vscode.window.showErrorMessage(
							'Invalid access token. Try signing in again.',
							{ modal: true },
							'Sign in with Github',
						);

						if (result !== 'Sign in with Github') {
							return;
						}

						const searchParams = new URLSearchParams();

						searchParams.set(
							SEARCH_PARAMS_KEYS.COMMAND,
							'accessTokenRequestedByVSCE',
						);

						const url = new URL('https://codemod.studio');
						url.search = searchParams.toString();

						vscode.commands.executeCommand('intuita.redirect', url);
					};

					vscode.commands.executeCommand(
						'workbench.view.extension.intuitaViewId',
					);

					const valid = await validateAccessToken(accessToken);
					if (valid) {
						userService.linkUserIntuitaAccount(accessToken);
						vscode.commands.executeCommand(
							'setContext',
							'intuita.signedIn',
							true,
						);
						store.dispatch(
							actions.setToaster({
								toastId: 'signIn',
								containerId: 'primarySidebarToastContainer',
								content: 'Successfully signed in',
								autoClose: 3000,
							}),
						);
					} else {
						await routeUserToStudioToAuthenticate();
						return;
					}

					const sourceControlState = state.sourceControl;

					if (
						sourceControlState.kind !==
						'ISSUE_CREATION_WAITING_FOR_AUTH'
					) {
						return;
					}

					const onSuccess = () => {
						store.dispatch(
							actions.setSourceControlTabProps({
								kind: 'IDLENESS',
							}),
						);
						store.dispatch(actions.setActiveTabId('codemodRuns'));
					};

					const onFail = async () => {
						userService.unlinkUserIntuitaAccount();
						store.dispatch(
							actions.setSourceControlTabProps({
								kind: 'ISSUE_CREATION_WAITING_FOR_AUTH',
								title: sourceControlState.title,
								body: sourceControlState.body,
							}),
						);
						await routeUserToStudioToAuthenticate();
					};

					store.dispatch(
						actions.setSourceControlTabProps({
							kind: 'WAITING_FOR_ISSUE_CREATION_API_RESPONSE',
							title: sourceControlState.title,
							body: sourceControlState.body,
						}),
					);

					await createIssue(
						sourceControlState.title,
						sourceControlState.body,
						accessToken,
						onSuccess,
						onFail,
					);
				}
			},
		}),
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'intuitaErrorViewId',
			errorWebviewProvider,
		),
	);

	messageBus.publish({
		kind: MessageKind.bootstrapEngine,
	});

	new HomeDirectoryService(messageBus, store, rootUri);

	messageBus.publish({
		kind: MessageKind.loadHomeDirectoryData,
	});
}
