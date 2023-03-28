import fs from 'fs/promises';
import {
	intro, outro, spinner,
} from '@clack/prompts';
import {
	black, green, red, bgCyan,
} from 'kolorist';
import { getStagedDiff } from '../utils/git.js';
import { getConfig } from '../utils/config.js';
import { CommitMessage, generateCommitMessage } from '../utils/openai.js';
import { KnownError, handleCliError } from '../utils/error.js';

const [messageFilePath, commitSource] = process.argv.slice(2);

export default () => (async () => {
	if (!messageFilePath) {
		throw new KnownError('Commit message file path is missing. This file should be called from the "prepare-commit-msg" git hook');
	}

	// If a commit message is passed in, ignore
	if (commitSource) {
		return;
	}

	// All staged files can be ignored by our filter
	const staged = await getStagedDiff();
	if (!staged) {
		return;
	}

	intro(bgCyan(black(' aicommits ')));

	const config = await getConfig();

	const s = spinner();
	s.start('The AI is analyzing your changes');
	let messages: CommitMessage[];
	try {
		messages = await generateCommitMessage(
			config.OPENAI_KEY,
			config.locale,
			staged!.diff,
			config.generate,
			config.conventional,
			config.gitmoji,
		);
	} finally {
		s.stop('Changes analyzed');
	}
	const hasMultipleMessages = messages.length > 1;
	let instructions = `# 🤖 AI generated commit${hasMultipleMessages ? 's' : ''}\n`;

	if (hasMultipleMessages) {
		instructions += '# Select one of the following messages by uncommeting:\n';
		instructions += `\n${messages.map(message => `# ${message}`).join('\n')}`;
	} else {
		instructions += '# Edit the message below and commit:\n';
		const commitMessage = messages[0] as CommitMessage;

		instructions += `\n${commitMessage.title}\n\n${commitMessage.description}\n`;
	}

	await fs.appendFile(
		messageFilePath,
		instructions,
	);
	outro(`${green('✔')} Saved commit message!`);
})().catch((error) => {
	outro(`${red('✖')} ${error.message}`);
	handleCliError(error);
	process.exit(1);
});
