import https from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import type { CreateChatCompletionRequest, CreateChatCompletionResponse } from 'openai';
import { encoding_for_model as encodingForModel } from '@dqbd/tiktoken';
import { KnownError } from './error.js';
import { retrieveGitmojis } from './gitmoji.js';

const httpsPost = async (
	hostname: string,
	path: string,
	headers: Record<string, string>,
	json: unknown,
) => new Promise<{
	request: ClientRequest;
	response: IncomingMessage;
	data: string;
}>((resolve, reject) => {
	const postContent = JSON.stringify(json);
	const request = https.request(
		{
			port: 443,
			hostname,
			path,
			method: 'POST',
			headers: {
				...headers,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(postContent),
			},
			timeout: 30_000, // 30s
		},
		(response) => {
			const body: Buffer[] = [];
			response.on('data', chunk => body.push(chunk));
			response.on('end', () => {
				resolve({
					request,
					response,
					data: Buffer.concat(body).toString(),
				});
			});
		},
	);
	request.on('error', reject);
	request.on('timeout', () => {
		request.destroy();
		reject(new KnownError('Request timed out'));
	});

	request.write(postContent);
	request.end();
});

const createChatCompletion = async (
	apiKey: string,
	json: CreateChatCompletionRequest,
) => {
	const { response, data } = await httpsPost(
		'api.openai.com',
		'/v1/chat/completions',
		{
			Authorization: `Bearer ${apiKey}`,
		},
		json,
	);

	if (
		!response.statusCode
		|| response.statusCode < 200
		|| response.statusCode > 299
	) {
		let errorMessage = `OpenAI API Error: ${response.statusCode} - ${response.statusMessage}`;

		if (data) {
			errorMessage += `\n\n${data}`;
		}

		if (response.statusCode === 500) {
			errorMessage += '\n\nCheck the API status: https://status.openai.com';
		}

		throw new KnownError(errorMessage);
	}

	return JSON.parse(data) as CreateChatCompletionResponse;
};

const deduplicateMessages = (array: string[]) => Array.from(new Set(array));

const getBasePrompt = (locale: string) => `
INSTRUCTIONS:\nI want you to act as the author of a commit message in git.
I'll enter a git diff, and your job is to convert it into a useful commit message.
Do not preface the commit with anything, use the present tense, return the full sentence.
The commit message must be in the language: ${locale}.`;

const getCommitMessageFormatPrompt = (useConventionalCommits: boolean, useGitmoji: boolean) => {
	const commitFormatParts = [];

	if (useConventionalCommits) {
		commitFormatParts.push('<conventional commits type (<type in lowercase>:');
	}

	if (useGitmoji) {
		commitFormatParts.push('<gitmoji> <subject>)>:');
	}

	if (!useGitmoji) {
		commitFormatParts.push('<subject>)>:');
	}

	commitFormatParts.push('<commit message>');

	// <conventional commit type>: <gitmoji> <commit message>
	return `The commit message should be in the following format: ${commitFormatParts.join(' ')}.`;
};

const getExtraContextForConventionalCommits = () => {
	// Based on https://medium.com/neudesic-innovation/conventional-commits-a-better-way-78d6785c2e08
	const conventionalCommitTypes: Record<string, string> = {
		/*
			Comment out feat: and fix: because they are too common and
			will cause the model to generate them too often.
		*/
		// feat: 'The commit implements a new feature for the application.',
		// fix: 'The commit fixes a defect in the application.',
		build: 'the commit alters the build system or external dependencies of the product.',
		change: 'the commit changes the implementation of an existing feature.',
		chore: 'the commit includes a technical or preventative maintenance task that is necessary for managing the product or the repository.',
		ci: 'the commit makes changes to continuous integration or continuous delivery scripts or configuration files.',
		deprecate: 'the commit deprecates existing functionality, but does not remove it from the product.',
		docs: 'the commit adds, updates, or revises documentation that is stored in the repository.',
		perf: 'the commit improves the performance of algorithms or general execution time of the product.',
		refactor: 'the commit refactors existing code in the product.',
		remove: 'the commit removes a feature from the product.',
		revert: 'the commit reverts one or more commits that were previously included in the product.',
		security: 'the commit improves the security of the product.',
		style: 'the commit updates or reformats the style of the source code.',
		test: 'the commit changes the suite of automated tests for the product.',
	};

	const extraContextList = [];

	// eslint-disable-next-line guard-for-in
	for (const key in conventionalCommitTypes) {
		const value = conventionalCommitTypes[key];
		const context = `When ${value} I want you to use the "${key}" conventional commit type.`;
		extraContextList.push(context);
	}

	return extraContextList.join(' ');
};

async function main() {
	const gitmojis = await retrieveGitmojis();
	let gitmojiDescriptions = '';
	for (const gitmoji of gitmojis) {
		gitmojiDescriptions += `${gitmoji.emoji}: ${gitmoji.description}\n`;
	}
	return gitmojiDescriptions;
}

const getExtraContextGitmoji = async () => {
	const gitmojiDescriptions = await main();
	return `Choose a gitmoji from the list below based on the conventional commit scope and git diff:\n${gitmojiDescriptions}`;
};

const gitCommitExample = (useConventionalCommits: boolean, useGitmoji: boolean) => {
	const commitFormatParts = [];

	if (useConventionalCommits && useGitmoji) {
		commitFormatParts.push('EXAMPLE:\nfeat: 🎉 Initial commit\n\nThis commit is the first commit of the repository');
	}

	return `${commitFormatParts.join(' ')}.`;
};

const model = 'gpt-3.5-turbo';
// TODO: update for the new gpt-3.5 model
const encoder = encodingForModel('text-davinci-003');

export const generateCommitMessage = async (
	apiKey: string,
	locale: string,
	diff: string,
	completions: number,
	useConventionalCommits: boolean,
	useGitmoji: boolean,
) => {
	const basePrompt = getBasePrompt(locale);
	const commitMessageFormatPrompt = getCommitMessageFormatPrompt(
		useConventionalCommits, useGitmoji,
	);

	const exampleCommitWithConventionalGitmoji = gitCommitExample(
		useConventionalCommits, useGitmoji,
	);

	const conventionalCommitsExtraContext = useConventionalCommits ? getExtraContextForConventionalCommits() : '';

	const gitMojiExtraContext = useGitmoji ? await getExtraContextGitmoji() : '';

	function sanitizeMessage(message: string): string {
		return message.replace(/<br>/g, '\n').replace(/\n{3,}/g, '\n');
	}

	const prompt = `${basePrompt}${commitMessageFormatPrompt}\n${conventionalCommitsExtraContext}\n\n${gitMojiExtraContext}\n\n${exampleCommitWithConventionalGitmoji}\n\n`;

	/**
	 * text-davinci-003 has a token limit of 4000
	 * https://platform.openai.com/docs/models/overview#:~:text=to%20Sep%202021-,text%2Ddavinci%2D003,-Can%20do%20any
	 */
	if (encoder.encode(prompt).length > 4000) {
		throw new KnownError('The diff is too large for the OpenAI API. Try reducing the number of staged changes, or write your own commit message.');
	}

	try {
		const completion = await createChatCompletion(apiKey, {
			model,
			messages: [{
				role: 'system',
				content: prompt,
			}, {
				role: 'user',
				content: diff,
			}],
			temperature: 0.7,
			top_p: 1,
			frequency_penalty: 0,
			presence_penalty: 0,
			max_tokens: 250,
			stream: false,
			n: completions,
		});

		return deduplicateMessages(
			completion.choices
				.filter(choice => choice.message?.content)
				.map(choice => sanitizeMessage(choice.message!.content)),
		);
	} catch (error) {
		const errorAsAny = error as any;
		if (errorAsAny.code === 'ENOTFOUND') {
			throw new KnownError(`Error connecting to ${errorAsAny.hostname} (${errorAsAny.syscall}). Are you connected to the internet?`);
		}

		throw errorAsAny;
	}
};
