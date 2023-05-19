export type CodemodHash = string & { __type: 'CodemodHash' };

export type CodemodPath = Readonly<{
	hash: CodemodHash;
	kind: 'path';
	label: string;
	path: string;
	children: CodemodHash[];
}>;

export type CodemodItem = Readonly<{
	hash: CodemodHash;
	kind: 'codemodItem';
	label: string;
	pathToExecute: string;
	description: string;
}>;

export type CodemodElement = CodemodItem | CodemodPath;

export type CodemodPathWithChildren = Omit<CodemodPath, 'children'> & {
	children: CodemodElementWithChildren[];
};

export type CodemodElementWithChildren = CodemodItem | CodemodPathWithChildren;
