import { useEffect, useState } from 'react';

import { VSCodeButton } from '@vscode/webview-ui-toolkit/react';

import { vscode } from '../shared/utilities/vscode';
import WarningMessage from '../shared/WarningMessage';

import CreateIssue from './CreateIssueView';
import CreatePR from './CreatePRView';

import type {
	View,
	WebviewMessage,
} from '../../../src/components/webview/webviewEvents';

declare global {
	interface Window {
		INITIAL_STATE: {
			repositoryPath: string | null;
			userId: string | null;
		};
	}
}

// @ts-ignore
const getViewComponent = (view: View) => {
	switch (view.viewId) {
		case 'createIssue': {
			return <CreateIssue {...view.viewProps} />;
		}
		case 'upsertPullRequest':
			return <CreatePR {...view.viewProps} />;
	}
};

function App() {
	const [configuredRepoPath, setConfiguredRepoPath] = useState<string | null>(
		window.INITIAL_STATE.repositoryPath,
	);
	const [linkedAccount, setLinkedAccount] = useState<string | null>(
		window.INITIAL_STATE.userId,
	);

	const [view, setView] = useState<View | null>(null);

	useEffect(() => {
		vscode.postMessage({ kind: 'webview.global.afterWebviewMounted' });
	}, []);

	useEffect(() => {
		const handler = (e: MessageEvent<WebviewMessage>) => {
			const message = e.data;
			if (message.kind === 'webview.global.setUserAccount') {
				setLinkedAccount(message.value);
			}

			if (message.kind === 'webview.global.setRepositoryPath') {
				setConfiguredRepoPath(message.repositoryPath);
			}

			if (message.kind === 'webview.global.setView') {
				setView(message.value);
			}

			if (
				message.kind === 'webview.createIssue.submittingIssue' &&
				view?.viewId === 'createIssue'
			) {
				setView({
					...view,
					viewProps: {
						...view.viewProps,
						initialFormData: {},
						loading: message.value,
					},
				});
			}

			if (
				message.kind === 'webview.createPR.setPullRequestSubmitting' &&
				view?.viewId === 'upsertPullRequest'
			) {
				setView({
					...view,
					viewProps: {
						...view.viewProps,
						initialFormData: {},
						loading: message.value,
					},
				});
			}
		};

		window.addEventListener('message', handler);

		return () => {
			window.removeEventListener('message', handler);
		};
	}, [view]);

	const handleLinkAccount = () => {
		vscode.postMessage({
			kind: 'webview.global.redirectToSignIn',
		});
	};

	const handleOpenExtensionSettings = () => {
		vscode.postMessage({
			kind: 'webview.global.openConfiguration',
		});
	};

	// @TODO detect remote automatically
	if (!configuredRepoPath) {
		return (
			<WarningMessage
				message="In order to create pull requests and issues, configure you repository settings"
				actionButtons={[
					<VSCodeButton onClick={handleOpenExtensionSettings}>
						Open settings
					</VSCodeButton>,
				]}
			/>
		);
	}

	if (!linkedAccount) {
		<WarningMessage
			message="In order to create pull requests and issues, link your Intuita account"
			actionButtons={[
				<VSCodeButton onClick={handleLinkAccount}>
					Link account
				</VSCodeButton>,
			]}
		/>;
	}

	if (!view) {
		return null;
	}

	return <main className="App">{getViewComponent(view)}</main>;
}

export default App;
