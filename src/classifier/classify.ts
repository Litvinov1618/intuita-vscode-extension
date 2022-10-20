import * as ts from 'typescript';
import { IntuitaSimpleRange } from '../utilities';
import { CaseKind, Classification, ClassifierDiagnostic } from './types';

const isRangeWithinNode = (node: ts.Node, range: IntuitaSimpleRange) =>
	node.getFullStart() <= range.start && node.getEnd() >= range.end;

const getTs2769ObjectAssignReplacementRange = (
	node: ts.Node,
): IntuitaSimpleRange | null => {
	if (!ts.isCallExpression(node.parent)) {
		return null;
	}

	const callExpression = node.parent;

	if (
		callExpression.arguments.length < 2 ||
		!ts.isPropertyAccessExpression(callExpression.expression)
	) {
		return null;
	}

	const pae = callExpression.expression;

	if (
		pae.expression.getText() !== 'Object' ||
		pae.name.getText() !== 'assign'
	) {
		return null;
	}

	return {
		// we do not take trivia (comments, whitespaces, etc.)
		// into account when generating replacement ranges
		start: callExpression.getStart(),
		end: callExpression.getEnd(),
	};
};

const getNode = (node: ts.Node, range: IntuitaSimpleRange): ts.Node | null => {
	if (!isRangeWithinNode(node, range)) {
		return null;
	}

	const children = node.getChildren();

	if (children.length === 0) {
		return node;
	}

	for (const child of children) {
		const result = getNode(child, range);

		if (result !== null) {
			return result;
		}
	}

	return null;
};

export const classify = (
	sourceFile: ts.SourceFile,
	diagnostic: ClassifierDiagnostic,
): Classification => {
	const otherClassification: Classification = {
		kind: CaseKind.OTHER,
		replacementRange: diagnostic.range,
	};

	const node = getNode(sourceFile, diagnostic.range);

	if (node === null) {
		return otherClassification;
	}

	if (diagnostic.code === '2769') {
		const replacementRange = getTs2769ObjectAssignReplacementRange(node);

		if (replacementRange) {
			return {
				kind: CaseKind.TS2769_OBJECT_ASSIGN,
				replacementRange,
			};
		}
	}

	return otherClassification;
};
